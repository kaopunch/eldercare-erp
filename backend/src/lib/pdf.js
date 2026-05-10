const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const FONT_REGULAR = 'ThaiRegular';
const FONT_BOLD = 'ThaiBold';

const localFontDir = path.join(__dirname, '..', '..', 'assets', 'fonts');

const FONT_CANDIDATES = [
  {
    path: process.env.ELDERCARE_PDF_FONT_PATH,
    boldPath: process.env.ELDERCARE_PDF_BOLD_FONT_PATH,
    regularFace: process.env.ELDERCARE_PDF_FONT_FACE,
    boldFace: process.env.ELDERCARE_PDF_BOLD_FONT_FACE
  },
  {
    path: path.join(localFontDir, 'NotoSansThai-Regular.ttf'),
    boldPath: path.join(localFontDir, 'NotoSansThai-Bold.ttf')
  },
  {
    path: path.join(localFontDir, 'Sarabun-Regular.ttf'),
    boldPath: path.join(localFontDir, 'Sarabun-Bold.ttf')
  },
  {
    path: '/System/Library/Fonts/Supplemental/Thonburi.ttc',
    regularFace: 'Thonburi',
    boldFace: 'Thonburi-Bold'
  },
  {
    path: '/System/Library/Fonts/ThonburiUI.ttc',
    regularFace: '.ThonburiUI-Regular',
    boldFace: '.ThonburiUI-Regular'
  }
];

function asciiText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '?')
    .replace(/\s+/g, ' ')
    .trim();
}

function exists(filePath) {
  return Boolean(filePath) && fs.existsSync(filePath);
}

function resolveFontCandidate() {
  return FONT_CANDIDATES.find((candidate) => exists(candidate.path));
}

function registerFont(doc, name, filePath, face) {
  if (face) {
    doc.registerFont(name, filePath, face);
  } else {
    doc.registerFont(name, filePath);
  }
}

function registerPdfFonts(doc) {
  const candidate = resolveFontCandidate();
  if (!candidate) {
    return {
      regular: 'Helvetica',
      bold: 'Helvetica-Bold',
      source: null,
      supportsUnicode: false
    };
  }

  registerFont(doc, FONT_REGULAR, candidate.path, candidate.regularFace);
  try {
    registerFont(doc, FONT_BOLD, candidate.boldPath || candidate.path, candidate.boldFace || candidate.regularFace);
  } catch (error) {
    registerFont(doc, FONT_BOLD, candidate.path, candidate.regularFace);
  }

  return {
    regular: FONT_REGULAR,
    bold: FONT_BOLD,
    source: candidate.path,
    supportsUnicode: true
  };
}

function pdfText(value, fonts) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return fonts.supportsUnicode ? text : asciiText(text);
}

function money(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number.toLocaleString('th-TH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }) : '0.00';
}

function dateTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('th-TH', {
    timeZone: 'Asia/Bangkok',
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date);
}

function serviceName(value) {
  const labels = {
    basic_ride: 'รับส่งทั่วไป',
    assisted_ride: 'รับส่งผู้สูงอายุพร้อมช่วยเหลือ',
    elderly_transport: 'รับส่งผู้สูงอายุ',
    hospital_companion: 'พาไปโรงพยาบาลพร้อมผู้ดูแล',
    home_companion: 'ดูแลเป็นเพื่อนที่บ้าน',
    medical_coordination: 'ประสานงานการแพทย์',
    family_monitoring: 'รายงานติดตามสำหรับครอบครัว',
    monthly_transport: 'รับส่งรายเดือน'
  };
  return labels[value] || value || '-';
}

function statusName(value) {
  const labels = {
    paid: 'ชำระแล้ว',
    issued: 'ออกเอกสารแล้ว',
    unpaid: 'ยังไม่ชำระ',
    deposit_paid: 'ชำระมัดจำแล้ว',
    completed: 'เสร็จสิ้น',
    confirmed: 'ยืนยันแล้ว',
    assigned: 'มอบหมายแล้ว'
  };
  return labels[value] || value || '-';
}

function collectPdf(render) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 48,
      bufferPages: true,
      info: {
        Creator: 'ElderCare ERP',
        Producer: 'ElderCare ERP'
      }
    });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const fonts = registerPdfFonts(doc);
    render(doc, fonts);
    doc.end();
  });
}

function drawHeader(doc, fonts, title, subtitle) {
  doc
    .fillColor('#173a35')
    .font(fonts.bold)
    .fontSize(22)
    .text(pdfText(title, fonts), 48, 48, { width: 340 });

  doc
    .font(fonts.regular)
    .fontSize(10)
    .fillColor('#5e6f6b')
    .text(pdfText(subtitle, fonts), 48, 79, { width: 340 });

  doc
    .font(fonts.bold)
    .fontSize(12)
    .fillColor('#173a35')
    .text('ElderCare ERP', 412, 52, { align: 'right', width: 135 });

  doc
    .font(fonts.regular)
    .fontSize(9)
    .fillColor('#5e6f6b')
    .text(pdfText('เอกสารระบบดูแลและรับส่งผู้สูงอายุ', fonts), 352, 72, { align: 'right', width: 195 });

  doc
    .moveTo(48, 116)
    .lineTo(547, 116)
    .lineWidth(1)
    .strokeColor('#d9e3e0')
    .stroke();
}

function drawRows(doc, fonts, rows, startY = 144) {
  let y = startY;
  rows.forEach(([label, value]) => {
    doc
      .font(fonts.bold)
      .fontSize(10)
      .fillColor('#5e6f6b')
      .text(pdfText(label, fonts), 48, y, { width: 140 });

    doc
      .font(fonts.regular)
      .fontSize(11)
      .fillColor('#173a35')
      .text(pdfText(value, fonts), 190, y - 1, { width: 350 });

    y += 28;
  });
  return y;
}

function drawAmountTable(doc, fonts, rows, startY) {
  const x = 48;
  const width = 499;
  let y = startY + 12;

  doc.roundedRect(x, y, width, 34, 6).fill('#edf5f3');
  doc
    .font(fonts.bold)
    .fontSize(10)
    .fillColor('#173a35')
    .text(pdfText('รายการ', fonts), x + 16, y + 10, { width: 280 })
    .text(pdfText('จำนวนเงิน', fonts), x + 350, y + 10, { width: 120, align: 'right' });

  y += 42;
  rows.forEach(([label, amount, strong = false]) => {
    doc
      .font(strong ? fonts.bold : fonts.regular)
      .fontSize(strong ? 12 : 11)
      .fillColor(strong ? '#173a35' : '#263f3b')
      .text(pdfText(label, fonts), x + 16, y, { width: 300 })
      .text(pdfText(`${money(amount)} บาท`, fonts), x + 350, y, { width: 120, align: 'right' });
    y += strong ? 31 : 27;
  });

  doc
    .moveTo(x, y - 14)
    .lineTo(x + width, y - 14)
    .lineWidth(1)
    .strokeColor('#d9e3e0')
    .stroke();

  return y;
}

function drawFooter(doc, fonts, text) {
  doc
    .moveTo(48, 738)
    .lineTo(547, 738)
    .lineWidth(1)
    .strokeColor('#d9e3e0')
    .stroke();

  doc
    .font(fonts.regular)
    .fontSize(9)
    .fillColor('#5e6f6b')
    .text(pdfText(text, fonts), 48, 752, { width: 499, align: 'center' });
}

function buildSimplePdf({ title, subtitle = '', rows = [], footer = '' }) {
  return collectPdf((doc, fonts) => {
    drawHeader(doc, fonts, title, subtitle);
    drawRows(doc, fonts, rows);
    drawFooter(doc, fonts, footer || 'Generated by ElderCare ERP');
  });
}

function invoicePdf(invoice, booking = {}) {
  return collectPdf((doc, fonts) => {
    drawHeader(
      doc,
      fonts,
      `ใบแจ้งหนี้ ${invoice.invoice_no}`,
      `เลขที่งาน ${booking.booking_no || invoice.booking_id || '-'} | ออกเอกสาร ${dateTime(invoice.issued_at)}`
    );

    const nextY = drawRows(doc, fonts, [
      ['ลูกค้า', booking.customers?.full_name || invoice.customer_id || '-'],
      ['บริการ', serviceName(booking.service_type)],
      ['เวลารับ', dateTime(booking.pickup_at)],
      ['สถานะ', statusName(invoice.status)]
    ]);

    drawAmountTable(doc, fonts, [
      ['ยอดก่อนภาษี', invoice.subtotal],
      ['ภาษีมูลค่าเพิ่ม', invoice.tax],
      ['ยอดรวมสุทธิ', invoice.total, true]
    ], nextY);

    drawFooter(doc, fonts, 'เอกสารนี้สร้างจาก ElderCare ERP และควรเก็บคู่กับหลักฐานการชำระเงิน');
  });
}

function receiptPdf(receipt) {
  const booking = receipt.booking || {};
  return collectPdf((doc, fonts) => {
    drawHeader(
      doc,
      fonts,
      `ใบเสร็จรับเงิน ${receipt.receipt_no}`,
      `เลขที่งาน ${booking.booking_no || '-'} | ออกเอกสาร ${dateTime(receipt.issued_at)}`
    );

    const nextY = drawRows(doc, fonts, [
      ['ลูกค้า', booking.customers?.full_name || '-'],
      ['ผู้สูงอายุ', booking.elders?.full_name || '-'],
      ['บริการ', serviceName(booking.service_type)],
      ['ปิดงาน', receipt.totals?.closed ? 'ปิดงานแล้ว' : 'ยังไม่ปิดงาน']
    ]);

    drawAmountTable(doc, fonts, [
      ['ยอดรวม', receipt.totals?.total],
      ['รับชำระแล้ว', receipt.totals?.net_paid],
      ['คืนเงินแล้ว', receipt.totals?.refunded],
      ['ยอดคงเหลือ', receipt.totals?.balance, true]
    ], nextY);

    drawFooter(doc, fonts, 'สร้างโดย ElderCare ERP สำหรับการตรวจสอบย้อนหลังและ audit log');
  });
}

module.exports = {
  buildSimplePdf,
  invoicePdf,
  money,
  receiptPdf
};
