# Auth Setup

ElderCare ERP supports two auth modes:

- `demo`: development mode. Role switching is allowed without a password.
- `pin`: production password mode. Users must log in with an app-user password and receive a signed session token.

## 1. Run SQL

Run these files in Supabase SQL Editor, in order:

1. `database/001_schema.sql`
2. `database/002_rls_policies.sql`
3. `database/003_app_user_login.sql`

## 2. Set User Password

Make sure `backend/.env` uses the Supabase `service_role` key, not the `anon` key:

```bash
npm run check:supabase-key
```

The output must show:

```json
{
  "supabase_key_role": "service_role",
  "service_role_ready": true
}
```

From `backend/`:

```bash
npm run set:user-password -- --email admin@example.com --password "change-me-strong"
```

or:

```bash
npm run set:user-password -- --user-id USER_UUID --password "change-me-strong"
```

Password hashes are stored in `app_user_credentials.login_pin_hash` using PBKDF2 SHA-256. The database column keeps its original name for backward compatibility.

## 3. Enable Production Auth

In `backend/.env`:

```bash
ELDERCARE_AUTH_MODE=pin
ELDERCARE_DEMO_AUTH=false
ELDERCARE_SESSION_SECRET=replace-with-a-long-random-secret
ELDERCARE_SESSION_HOURS=12
```

Restart the backend after changing `.env`.

## Notes

- The backend still uses `SUPABASE_SERVICE_ROLE_KEY` for server-side data access.
- Direct access to `app_user_credentials` is blocked by RLS; the service role bypasses RLS for backend verification.
- `ELDERCARE_AUTH_MODE=pin` now means production password login mode.
- If `database/003_app_user_login.sql` has not been run, password login returns `AUTH_SCHEMA_MISSING`.
