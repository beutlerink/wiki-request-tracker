# Wikipedia Request Tracker (shared hosting)

Hosts the tracker on a real URL with shared, always-saving data for the whole team,
plus read-only client links per project.

- **Internal URL** (behind a team password): full access, every project, live edits sync for everyone.
- **Client links** (`/c/<token>`): read-only, one project, sanitized. A client never receives other projects or your account roster.

## What you'll end up with

- One Render **web service** (the app).
- One Render **Postgres** database (the shared data).
- A team login (one shared username + password) for the internal URL.
- A "Copy client link" button inside the app for each project.

## Setup (GitHub + Render Blueprint)

**1. Put these files in a GitHub repo.**
Create a new repository, then upload the contents of this folder (the whole thing except `node_modules/`, which is ignored). On github.com you can use **Add file → Upload files** and drag everything in.

**2. Create the Blueprint on Render.**
In Render: **New → Blueprint**, choose your GitHub repo, and confirm. Render reads `render.yaml` and sets up the database and the web service, wiring them together automatically.

**3. Enter the two secrets when prompted.**
- `INTERNAL_USER` — the team login name (e.g. `beutler`)
- `INTERNAL_PASS` — a strong shared password

These are the credentials the team uses to open the internal URL. Share them only internally.

**4. Apply / deploy.**
Render builds and starts the service and gives you a URL like `https://request-tracker.onrender.com`.

**5. Open the URL and log in** with the username/password from step 3. Build your projects as usual. To hand a client their view, open **Manage projects**, select the project, and click **Copy client link**.

That's it. Every teammate who opens the internal URL and logs in sees the same live board.

## Costs (on top of your workspace plan)

The Blueprint defaults to durable + always-on:
- Postgres `basic-256mb`: ~$6/mo, data never expires.
- Web service `starter`: $7/mo, no cold starts.

To trial for less, edit `render.yaml` before deploying:
- Database `plan: free` — $0, but the free database **expires 30 days after creation**.
- Web service `plan: free` — $0, but it **sleeps after 15 minutes idle and takes ~1 minute to wake** on the next visit (noticeable when a client opens a link).

## Enabling AI reading of discussions

The tracker can have an AI model read each Wikipedia discussion and set an accurate status (including "Partially implemented") plus a one-line summary of the latest state, instead of guessing from keywords.

To turn it on, add one environment variable to the web service in Render:

1. Open the `request-tracker` service → **Environment**.
2. Add `ANTHROPIC_API_KEY` and paste an API key from https://console.anthropic.com (Settings → API Keys).
3. Save. Render redeploys automatically.

It uses Claude Haiku 4.5 (the fastest, cheapest model, about $1 per million input tokens) and caches each reading, so a discussion is only re-read when its content changes. At normal volume the cost is a few cents. Inside the app, use **Re-read discussions** to force a fresh pass. Without the key, the app falls back to the old keyword-based statuses and the button shows "AI reading off."

## Updating the app later

Push a change to the repo (or upload the new file on GitHub). Render redeploys automatically. Your data lives in Postgres, so it is untouched by redeploys.

## Notes

- A project's client link is tied to its **name**. Renaming a project invalidates its old link; click **Copy client link** again to get a fresh one.
- Simultaneous edits use last-write-wins per item. For a small team this is fine; the app also refreshes from the server every few seconds so everyone stays roughly in sync.
- The same HTML file still works offline: open it directly and it falls back to local (per-browser) storage.
