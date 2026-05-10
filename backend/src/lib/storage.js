const path = require('path');

const DEFAULT_PAYMENT_EVIDENCE_BUCKET = 'payment-evidence';
const MAX_EVIDENCE_BYTES = 6 * 1024 * 1024;
const ALLOWED_EVIDENCE_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp'
]);

function paymentEvidenceBucket() {
  return process.env.ELDERCARE_PAYMENT_EVIDENCE_BUCKET || DEFAULT_PAYMENT_EVIDENCE_BUCKET;
}

function evidenceRef(bucket, objectPath) {
  return `storage://${bucket}/${objectPath}`;
}

function parseEvidenceRef(value) {
  const match = String(value || '').match(/^storage:\/\/([^/]+)\/(.+)$/);
  if (!match) return null;
  return { bucket: match[1], path: match[2] };
}

function safeFileName(fileName) {
  const parsed = path.parse(String(fileName || 'evidence'));
  const base = parsed.name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'evidence';
  const ext = parsed.ext.toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 12);
  return `${base}${ext || '.bin'}`;
}

function decodeUploadBody(body = {}) {
  const contentType = String(body.content_type || '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_EVIDENCE_TYPES.has(contentType)) {
    const error = new Error('payment evidence must be PDF, JPEG, PNG, or WebP');
    error.statusCode = 422;
    error.code = 'PAYMENT_EVIDENCE_TYPE_INVALID';
    throw error;
  }

  const dataUrl = String(body.data_url || '');
  const base64 = body.data_base64 || (dataUrl.includes(',') ? dataUrl.split(',').pop() : '');
  if (!base64) {
    const error = new Error('payment evidence file content is required');
    error.statusCode = 422;
    error.code = 'PAYMENT_EVIDENCE_EMPTY';
    throw error;
  }

  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length || buffer.length > MAX_EVIDENCE_BYTES) {
    const error = new Error('payment evidence file is empty or larger than 6 MB');
    error.statusCode = 422;
    error.code = 'PAYMENT_EVIDENCE_SIZE_INVALID';
    error.details = { max_bytes: MAX_EVIDENCE_BYTES };
    throw error;
  }
  return { buffer, contentType };
}

async function ensureBucket(sb, bucket) {
  const { data } = await sb.storage.getBucket(bucket);
  if (data) return;
  const { error } = await sb.storage.createBucket(bucket, {
    public: false,
    fileSizeLimit: MAX_EVIDENCE_BYTES,
    allowedMimeTypes: [...ALLOWED_EVIDENCE_TYPES]
  });
  if (error && !/already exists/i.test(error.message || '')) {
    throw error;
  }
}

async function uploadPaymentEvidence(sb, {
  bookingId,
  paymentId = null,
  fileName,
  contentType,
  buffer
}) {
  const bucket = paymentEvidenceBucket();
  await ensureBucket(sb, bucket);
  const objectPath = [
    'payments',
    bookingId,
    paymentId || 'pending',
    `${Date.now()}-${safeFileName(fileName)}`
  ].join('/');

  const { data, error } = await sb.storage.from(bucket).upload(objectPath, buffer, {
    cacheControl: '3600',
    contentType,
    upsert: false
  });
  if (error) throw error;

  return {
    bucket,
    path: data?.path || objectPath,
    ref: evidenceRef(bucket, data?.path || objectPath)
  };
}

async function signedEvidenceUrl(sb, evidenceUrl, expiresIn = 60 * 10) {
  const parsed = parseEvidenceRef(evidenceUrl);
  if (!parsed) return { url: evidenceUrl || null, storage: false };
  const { data, error } = await sb.storage.from(parsed.bucket).createSignedUrl(parsed.path, expiresIn);
  if (error) throw error;
  return {
    url: data.signedUrl,
    storage: true,
    bucket: parsed.bucket,
    path: parsed.path,
    expires_in: expiresIn
  };
}

module.exports = {
  decodeUploadBody,
  evidenceRef,
  parseEvidenceRef,
  paymentEvidenceBucket,
  signedEvidenceUrl,
  uploadPaymentEvidence
};
