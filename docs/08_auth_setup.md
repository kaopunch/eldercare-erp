# Auth Setup

ElderCare ERP supports two auth modes:

- `demo`: development mode. Role switching is allowed without PIN.
- `pin`: production mode. Users must log in with an app-user PIN and receive a signed session token.

## 1. Run SQL

Run these files in Supabase SQL Editor, in order:

1. `database/001_schema.sql`
2. `database/002_rls_policies.sql`
3. `database/003_app_user_login.sql`

## 2. Set User PIN

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
npm run set:user-pin -- --email admin@example.com --pin 123456
```

or:

```bash
npm run set:user-pin -- --user-id USER_UUID --pin 123456
```

PIN hashes are stored in `app_user_credentials.login_pin_hash` using PBKDF2 SHA-256.

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
- If `database/003_app_user_login.sql` has not been run, PIN login returns `AUTH_SCHEMA_MISSING`.
