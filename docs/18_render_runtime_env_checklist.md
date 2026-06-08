# Render Runtime Environment Checklist

ใช้ checklist นี้หลัง deploy หรือหลังแก้ `render.yaml` เพื่อให้ production readiness ผ่านโดยไม่ต้องเปิดค่า secret ในเอกสาร

## Public Values

ค่าเหล่านี้ไม่ใช่ secret และตั้งใน `render.yaml` ได้:

| Key | Expected value |
| --- | --- |
| `NODE_ENV` | `production` |
| `ELDERCARE_AUTH_MODE` | `pin` |
| `ELDERCARE_DEMO_AUTH` | `false` |
| `ELDERCARE_SESSION_HOURS` | `12` |
| `ELDERCARE_PAYMENT_EVIDENCE_BUCKET` | `payment-evidence` |
| `ELDERCARE_CORS_ORIGINS` | `https://eldercare-erp.onrender.com` หรือ custom domain |
| `ELDERCARE_PUBLIC_BASE_URL` | `https://eldercare-erp.onrender.com` หรือ custom domain |
| `ELDERCARE_API_RATE_LIMIT_MAX` | `600` |
| `ELDERCARE_AUTH_RATE_LIMIT_MAX` | `30` |
| `ELDERCARE_PORTAL_RATE_LIMIT_MAX` | `240` |
| `ELDERCARE_AI_INBOUND_RATE_LIMIT_MAX` | `180` |
| `AI_ANALYSIS_TIMEOUT_MS` | `8000` |

## Secret Values

ค่าเหล่านี้ต้องใส่ผ่าน Render Dashboard หรือ secret manager เท่านั้น:

| Key | Required before pilot | Notes |
| --- | --- | --- |
| `SUPABASE_URL` | Yes | Project URL from Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Must be `service_role`, not anon |
| `ELDERCARE_SESSION_SECRET` | Yes | Long random secret for staff sessions |
| `PORTAL_TOKEN_SECRET` | Yes | Separate long random secret for customer portal tokens |
| `ELDERCARE_AI_WEBHOOK_SECRET` | Before real AI inbound | Required for production AI/webhook providers |
| `ELDERCARE_AI_ANALYSIS_URL` | Optional | External classifier/provider endpoint |
| `ELDERCARE_AI_ANALYSIS_SECRET` | Optional | Bearer token for AI analysis provider |
| `ELDERCARE_OUTBOUND_DELIVERY_URL` | Optional | Gateway for WhatsApp/SMS/call delivery |
| `ELDERCARE_OUTBOUND_DELIVERY_SECRET` | Optional | Gateway auth secret |
| `LINE_CHANNEL_ACCESS_TOKEN` | Before LINE pilot | LINE Messaging API token |

## Verification

Run locally after env changes:

```bash
cd backend
npm run verify:runtime -- --base-url=https://eldercare-erp.onrender.com
```

Expected before Supabase DNS is fixed:

- Render health: pass
- Render auth config: pass
- Render readiness auth guard: pass
- Supabase DNS: fail if project host is not resolvable

Expected before pilot:

- Supabase DNS: pass
- schema probes: pass
- payment evidence storage: pass or an accepted warning with owner
- authenticated `/api/readiness`: no core auth/schema/storage fail

## Render Dashboard Steps

1. Open the `eldercare-erp` service in Render
2. Go to Environment
3. Add or update all required secret values
4. Save changes
5. Trigger Manual Deploy or wait for auto deploy
6. Run the verification command above

## Custom Domain Notes

When using a custom domain:

- Add the custom domain to Render
- Set `ELDERCARE_PUBLIC_BASE_URL` to the custom domain
- Set `ELDERCARE_CORS_ORIGINS` to the custom domain
- Keep the Render URL only if staff will still access the app there
