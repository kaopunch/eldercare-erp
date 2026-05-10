const express = require('express');
const { getSupabase } = require('../db/supabase');
const { queueCustomerNotification } = require('../lib/notifications');
const { invoicePdf, receiptPdf } = require('../lib/pdf');
const {
  decodeUploadBody,
  signedEvidenceUrl,
  uploadPaymentEvidence
} = require('../lib/storage');

const router = express.Router();

function invoiceNo() {
  return `INV${Date.now()}`;
}

function receiptNo(bookingNo) {
  return `RCPT-${bookingNo || Date.now()}`;
}

function groupByBooking(rows = []) {
  return rows.reduce((groups, row) => {
    if (!row.booking_id) return groups;
    if (!groups[row.booking_id]) groups[row.booking_id] = [];
    groups[row.booking_id].push(row);
    return groups;
  }, {});
}

function numeric(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

async function getPaymentBalance(sb, bookingId) {
  const [booking, payments, refunds] = await Promise.all([
    sb.from('bookings').select('id,booking_no,service_type,pickup_at,final_price,quoted_price').eq('id', bookingId).single(),
    sb.from('payments').select('amount,payment_status').eq('booking_id', bookingId),
    sb.from('refunds').select('amount,status').eq('booking_id', bookingId)
  ]);
  if (booking.error) throw booking.error;
  if (payments.error) throw payments.error;
  if (refunds.error) throw refunds.error;

  const total = numeric(booking.data.final_price || booking.data.quoted_price);
  const paid = (payments.data || [])
    .filter((payment) => !['refunded', 'partial_refunded'].includes(payment.payment_status))
    .reduce((sum, payment) => sum + numeric(payment.amount), 0);
  const refunded = (refunds.data || [])
    .filter((refund) => ['approved', 'paid'].includes(refund.status))
    .reduce((sum, refund) => sum + numeric(refund.amount), 0);
  const balance = Math.max(0, Math.round((total - Math.max(0, paid - refunded)) * 100) / 100);
  return { booking: booking.data, total, paid, refunded, balance };
}

async function buildReceipt(sb, bookingId) {
  const [booking, invoices, payments, refunds] = await Promise.all([
    sb.from('bookings')
      .select('id,company_id,booking_no,customer_id,elder_id,service_type,pickup_at,final_price,quoted_price,payment_status,customers(full_name,phone,line_id),elders(full_name,mobility_level)')
      .eq('id', bookingId)
      .single(),
    sb.from('invoices').select('*').eq('booking_id', bookingId).order('issued_at', { ascending: false }),
    sb.from('payments').select('*').eq('booking_id', bookingId).order('paid_at', { ascending: false }),
    sb.from('refunds').select('*').eq('booking_id', bookingId).order('created_at', { ascending: false })
  ]);
  if (booking.error) throw booking.error;
  if (invoices.error) throw invoices.error;
  if (payments.error) throw payments.error;
  if (refunds.error) throw refunds.error;

  const total = numeric(booking.data.final_price || booking.data.quoted_price);
  const paid = (payments.data || [])
    .filter((payment) => !['refunded', 'partial_refunded'].includes(payment.payment_status))
    .reduce((sum, payment) => sum + numeric(payment.amount), 0);
  const refunded = (refunds.data || [])
    .filter((refund) => ['approved', 'paid'].includes(refund.status))
    .reduce((sum, refund) => sum + numeric(refund.amount), 0);
  const netPaid = Math.max(0, Math.round((paid - refunded) * 100) / 100);
  const balance = Math.max(0, Math.round((total - netPaid) * 100) / 100);
  const latestInvoice = (invoices.data || [])[0] || null;

  await sb.from('audit_logs').insert({
    company_id: booking.data.company_id || null,
    action: 'receipt_viewed',
    entity_type: 'booking',
    entity_id: booking.data.id,
    payload: {
      booking_no: booking.data.booking_no,
      receipt_no: receiptNo(booking.data.booking_no),
      total,
      net_paid: netPaid,
      balance
    }
  });

  return {
    receipt_no: receiptNo(booking.data.booking_no),
    issued_at: new Date().toISOString(),
    booking: booking.data,
    invoice: latestInvoice,
    payments: payments.data || [],
    refunds: refunds.data || [],
    totals: {
      total,
      paid,
      refunded,
      net_paid: netPaid,
      balance,
      closed: balance <= 0.01
    }
  };
}

router.get('/finance/ledger', async (_, res, next) => {
  try {
    const sb = getSupabase();
    const [bookings, payments, invoices, refunds] = await Promise.all([
      sb.from('bookings')
        .select('id,booking_no,customer_id,elder_id,service_type,pickup_at,status,final_price,quoted_price,payment_status,customers(full_name,phone),elders(full_name)')
        .order('pickup_at', { ascending: true }),
      sb.from('payments').select('*').order('paid_at', { ascending: false }),
      sb.from('invoices').select('*').order('issued_at', { ascending: false }),
      sb.from('refunds').select('*').order('created_at', { ascending: false })
    ]);
    if (bookings.error) throw bookings.error;
    if (payments.error) throw payments.error;
    if (invoices.error) throw invoices.error;
    if (refunds.error) throw refunds.error;

    const paymentsByBooking = groupByBooking(payments.data || []);
    const invoicesByBooking = groupByBooking(invoices.data || []);
    const refundsByBooking = groupByBooking(refunds.data || []);
    const ledger = (bookings.data || []).map((booking) => ({
      ...booking,
      payments: paymentsByBooking[booking.id] || [],
      invoices: invoicesByBooking[booking.id] || [],
      refunds: refundsByBooking[booking.id] || []
    }));

    res.json({ ok: true, ledger });
  } catch (e) { next(e); }
});

router.post('/payments', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const requestedAmount = numeric(req.body.amount);
    const current = await getPaymentBalance(sb, req.body.booking_id);
    if (current.balance <= 0) {
      const error = new Error('booking has no remaining payment balance');
      error.statusCode = 422;
      error.code = 'PAYMENT_BALANCE_CLOSED';
      throw error;
    }
    if (requestedAmount <= 0 || requestedAmount - current.balance > 0.01) {
      const error = new Error(`payment amount must be between 0 and remaining balance ${current.balance}`);
      error.statusCode = 422;
      error.code = 'PAYMENT_AMOUNT_INVALID';
      error.details = { requestedAmount, remainingBalance: current.balance };
      throw error;
    }

    const nextPaymentStatus = Math.abs(requestedAmount - current.balance) <= 0.01
      ? 'paid'
      : (req.body.payment_status || 'deposit_paid');
    const { data, error } = await sb.from('payments').insert({
      booking_id: req.body.booking_id,
      payment_method: req.body.payment_method,
      amount: requestedAmount,
      payment_status: nextPaymentStatus,
      paid_at: req.body.paid_at || new Date().toISOString(),
      transaction_ref: req.body.transaction_ref || null,
      evidence_url: req.body.evidence_url || null
    }).select('*').single();
    if (error) throw error;

    await sb.from('bookings').update({ payment_status: data.payment_status }).eq('id', req.body.booking_id);
    if (data.payment_status === 'paid') {
      await sb.from('invoices').update({ status: 'paid' }).eq('booking_id', req.body.booking_id).neq('status', 'void');
    }
    await queueCustomerNotification(sb, current.booking, 'payment_received', {
      payment_id: data.id,
      amount: data.amount,
      payment_method: data.payment_method,
      payment_status: data.payment_status,
      transaction_ref: data.transaction_ref
    });
    res.status(201).json({ ok: true, payment: data });
  } catch (e) { next(e); }
});

router.post('/payments/evidence', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const paymentId = req.body.payment_id || null;
    let bookingId = req.body.booking_id || null;
    let payment = null;

    if (paymentId) {
      const { data, error } = await sb.from('payments')
        .select('id,booking_id,evidence_url')
        .eq('id', paymentId)
        .single();
      if (error) throw error;
      payment = data;
      bookingId = bookingId || payment.booking_id;
    }

    if (!bookingId) {
      const error = new Error('booking_id or payment_id is required');
      error.statusCode = 422;
      error.code = 'PAYMENT_EVIDENCE_TARGET_REQUIRED';
      throw error;
    }

    const { data: booking, error: bookingError } = await sb.from('bookings')
      .select('id,company_id,booking_no')
      .eq('id', bookingId)
      .single();
    if (bookingError) throw bookingError;

    const { buffer, contentType } = decodeUploadBody(req.body);
    const uploaded = await uploadPaymentEvidence(sb, {
      bookingId,
      paymentId,
      fileName: req.body.file_name || 'payment-evidence',
      contentType,
      buffer
    });

    if (paymentId) {
      const { error } = await sb.from('payments')
        .update({ evidence_url: uploaded.ref })
        .eq('id', paymentId);
      if (error) throw error;
    }

    await sb.from('audit_logs').insert({
      company_id: booking.company_id || null,
      actor_user_id: req.actor?.id || null,
      action: 'payment_evidence_uploaded',
      entity_type: paymentId ? 'payment' : 'booking',
      entity_id: paymentId || booking.id,
      payload: {
        booking_id: booking.id,
        booking_no: booking.booking_no,
        payment_id: paymentId,
        storage_path: uploaded.path
      }
    });

    const signed = await signedEvidenceUrl(sb, uploaded.ref);
    res.status(201).json({
      ok: true,
      evidence: {
        payment_id: paymentId,
        booking_id: booking.id,
        evidence_url: uploaded.ref,
        signed_url: signed.url,
        expires_in: signed.expires_in
      }
    });
  } catch (e) { next(e); }
});

router.get('/payments/:id/evidence', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const { data, error } = await sb.from('payments')
      .select('id,booking_id,evidence_url')
      .eq('id', req.params.id)
      .single();
    if (error) throw error;
    if (!data.evidence_url) {
      const err = new Error('payment evidence is not attached');
      err.statusCode = 404;
      err.code = 'PAYMENT_EVIDENCE_NOT_FOUND';
      throw err;
    }
    const signed = await signedEvidenceUrl(sb, data.evidence_url);
    res.json({ ok: true, evidence: { payment_id: data.id, booking_id: data.booking_id, ...signed } });
  } catch (e) { next(e); }
});

router.get('/bookings/:id/payments', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const { data, error } = await sb.from('payments')
      .select('*')
      .eq('booking_id', req.params.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ ok: true, payments: data });
  } catch (e) { next(e); }
});

router.get('/bookings/:id/receipt', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const receipt = await buildReceipt(sb, req.params.id);
    res.json({ ok: true, receipt });
  } catch (e) { next(e); }
});

router.get('/bookings/:id/receipt.pdf', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const receipt = await buildReceipt(sb, req.params.id);
    const pdf = await receiptPdf(receipt);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${receipt.receipt_no}.pdf"`);
    res.send(pdf);
  } catch (e) { next(e); }
});

router.post('/invoices', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const { data: booking, error: bookingError } = await sb.from('bookings')
      .select('id,booking_no,customer_id,service_type,pickup_at,final_price,quoted_price')
      .eq('id', req.body.booking_id)
      .single();
    if (bookingError) throw bookingError;

    const subtotal = Number(req.body.subtotal ?? booking.final_price ?? booking.quoted_price ?? 0);
    const tax = Number(req.body.tax ?? Math.round(subtotal * 0.07 * 100) / 100);
    const total = Number(req.body.total ?? subtotal + tax);
    const { data, error } = await sb.from('invoices').insert({
      booking_id: booking.id,
      invoice_no: req.body.invoice_no || invoiceNo(),
      customer_id: req.body.customer_id || booking.customer_id,
      subtotal,
      tax,
      total,
      status: req.body.status || 'issued',
      issued_at: req.body.issued_at || new Date().toISOString()
    }).select('*').single();
    if (error) throw error;
    await queueCustomerNotification(sb, booking, 'invoice_issued', {
      invoice_id: data.id,
      invoice_no: data.invoice_no,
      subtotal: data.subtotal,
      tax: data.tax,
      total: data.total,
      status: data.status
    });
    res.status(201).json({ ok: true, invoice: data });
  } catch (e) { next(e); }
});

router.get('/invoices/:id', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const { data, error } = await sb.from('invoices').select('*').eq('id', req.params.id).single();
    if (error) throw error;
    res.json({ ok: true, invoice: data });
  } catch (e) { next(e); }
});

router.get('/invoices/:id/pdf', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const { data: invoice, error } = await sb.from('invoices').select('*').eq('id', req.params.id).single();
    if (error) throw error;
    const { data: booking, error: bookingError } = await sb.from('bookings')
      .select('id,booking_no,customer_id,service_type,pickup_at,customers(full_name,phone,line_id)')
      .eq('id', invoice.booking_id)
      .single();
    if (bookingError) throw bookingError;
    const pdf = await invoicePdf(invoice, booking);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${invoice.invoice_no}.pdf"`);
    res.send(pdf);
  } catch (e) { next(e); }
});

router.post('/refunds', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const { data, error } = await sb.from('refunds').insert({
      payment_id: req.body.payment_id,
      booking_id: req.body.booking_id,
      amount: req.body.amount,
      reason: req.body.reason,
      approved_by: req.body.approved_by || null,
      approved_at: req.body.approved_by ? new Date().toISOString() : null,
      status: req.body.approved_by ? 'approved' : 'pending'
    }).select('*').single();
    if (error) throw error;
    if (data.status === 'approved' && data.booking_id) {
      await sb.from('bookings').update({ payment_status: 'partial_refunded' }).eq('id', data.booking_id);
    }
    res.status(201).json({ ok: true, refund: data });
  } catch (e) { next(e); }
});

module.exports = router;
