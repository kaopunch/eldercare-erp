# Payment Evidence Storage

Finance Desk can attach payment evidence files to `payments.evidence_url`.

This feature requires the backend to use the Supabase `service_role` key in `SUPABASE_SERVICE_ROLE_KEY`, because the bucket is private and RLS must be enforced by the backend.

Check it with:

```bash
npm run check:supabase-key
```

Supported files:
- PDF
- JPEG
- PNG
- WebP

Default bucket:

```bash
ELDERCARE_PAYMENT_EVIDENCE_BUCKET=payment-evidence
```

The backend uploads files with the Supabase service role, stores a stable reference like:

```text
storage://payment-evidence/payments/BOOKING_ID/PAYMENT_ID/...
```

When a user clicks "View evidence", the backend generates a short-lived signed URL. This keeps the bucket private while still allowing finance users to inspect evidence.

The backend will try to create the private bucket automatically on first upload. If your Supabase project blocks bucket creation through the service role, create a private bucket named `payment-evidence` in Supabase Storage.
