# Free Cloud Deploy Guide: Render + Supabase

Recommended free path for this project:

- Backend + frontend: Render Free Web Service
- Database/Auth/storage metadata: existing Supabase project
- Static frontend: served by the Express backend from `frontend/index.html`

## Why Render

The app is a Node.js Express API that also serves the frontend. Render supports free Node web services and lets the app listen on Render's `PORT` environment variable. Free services can spin down after idle time, so first requests after inactivity may take around a minute.

## Files added

- `render.yaml`: Render Blueprint for a free Singapore web service.
- `.gitignore`: Keeps `.env`, `node_modules`, and local files out of Git.

## Deploy Steps

1. Create a GitHub repository from the `eldercare_erp_starter_v1` folder.
2. Push the project to GitHub.
3. In Render, choose **New > Blueprint** and select the repository.
4. Render reads `render.yaml`.
5. Fill required secret values in Render:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `ELDERCARE_SESSION_SECRET`
   - Optional integrations: `LINE_CHANNEL_ACCESS_TOKEN`, AI/outbound webhook secrets.
6. Deploy.
7. Open the Render URL and check:
   - `/health`
   - `/api/readiness` after logging in with an admin session.

## Important Production Notes

- Do not upload `backend/.env` to GitHub.
- Keep `ELDERCARE_DEMO_AUTH=false` in cloud.
- Use a long random `ELDERCARE_SESSION_SECRET`.
- Render Free Web Services have idle spin-down and ephemeral filesystem. Persist data in Supabase, not local files.
- Render Free Postgres is not needed here because the system already uses Supabase.

## Local Verification Before Push

```bash
cd backend
npm test
npm start
```

Then open:

```text
http://127.0.0.1:8081/health
```
