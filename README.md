# McDonald Hills GC — Irrigation Scheduler

A small self-contained web app for scheduling and manually controlling the
Hunter Pro-HC PHC-2400 (24-zone Wi-Fi controller). It runs in **demo mode**
until you connect it to your own Hydrawise account, so your crew can start
using it today, even while the controller is still tied to the previous
owner's Hydrawise login.

This is the Render + Supabase version — it doesn't touch WordPress or
InnerDigital's hosting at all. It lives at its own Render URL, with its
data in a Supabase Postgres database.

## What it does

- **Dashboard** — live status of all 24 zones.
- **Programs** — recurring watering schedules (days, start time, zones, run
  time per zone, seasonal % adjustment). Admins only. A built-in scheduler
  (an in-process timer, since Render web services run continuously) checks
  every minute and starts zones automatically.
- **Manual Control** — start/stop/suspend any zone, or run/stop everything,
  right now. Available to crew and admins.
- **Run Log** — history of every scheduled and manual action.
- **Users** — admin/crew accounts with different permissions.
- **Settings** — where you'll paste your Hydrawise API key once the
  controller is released from the previous owner's account.

## Deploying

### 1. Database (Supabase)

You already have a Supabase project for this (McDonald Hills GC org). Grab
its connection string from **Project Settings → Database → Connection
string** (the URI, with the real password substituted in). The app creates
its own tables and seeds default data automatically on first boot — no
manual schema setup needed.

### 2. Render

1. In Render, **New + → Web Service**, connect this GitHub repo.
2. Runtime: **Node**. Build command: `npm install`. Start command: `npm start`.
3. **Plan: choose Starter, not Free.** The scheduler that triggers watering
   programs only runs while the service is awake — Render's Free tier spins
   a service down after 15 minutes of no web traffic, which would silently
   stop programs from firing at their scheduled times. Starter (or higher)
   stays running continuously.
4. Add environment variables:
   - `DATABASE_URL` — the Supabase connection string from step 1
   - `SESSION_SECRET` — any long random string (Render can generate one)
   - `NODE_ENV` — `production`
5. Deploy. Once it's live, visit the URL and log in.

A `render.yaml` is included if you'd rather use Render's Blueprint deploy
(New + → Blueprint) — it pre-fills all of the above except the database
connection string, which you'll still paste in manually since it's a secret.

### 3. First login

Default accounts (you'll be forced to set a new password on first login):

- `admin` / `changeme123`
- `crew` / `changeme123`

### 4. Not linked anywhere public

Nothing in WordPress points at this — it only exists at its Render URL, and
the app itself requires login on top of that. That satisfies "not
accessible to everyone" without needing any WordPress changes.

## Connecting the real controller (once it's released)

1. In your own Hydrawise account (app.hydrawise.com), add the controller
   once the previous owner has released it.
2. Hydrawise account menu → **Account Details** → **Account Settings** →
   **Generate API Key**.
3. In this app, go to **Settings** (admin only) and paste the API key. Live
   mode turns on automatically — every page already calls through the same
   `HydrawiseClient` class; it just stops simulating and starts talking to
   the real controller.
4. Optionally fill in the zone-by-zone "Hydrawise Relay ID" on the **Zones**
   page if your station numbering in Hydrawise doesn't match 1–24 exactly.

Note on scope: the free/personal Hydrawise API lets you read status and
manually run/stop/suspend zones, but it doesn't let outside apps write a
full recurring "program" onto the controller itself. That's why this app
keeps its own schedule (in the `programs` table) and tells Hydrawise "start
zone X for Y minutes" at the right moments, rather than editing Hydrawise's
own program screen. End result is the same fully automatic watering.

## Local development

```
npm install
cp .env.example .env   # then edit DATABASE_URL to point at a local or dev Postgres
npm start
```

## File map

```
server.js          - all routes + the in-process scheduler
lib/
  config is inline in server.js / db.js
  db.js             - Postgres pool + auto-seed on first boot
  auth.js           - sessions, login, role checks
  settings.js        - key/value settings + run_log writer
  hydrawise.js       - mock/live Hydrawise API wrapper (the key extension point)
  helpers.js        - CSRF, day-mask math, timezone-aware date helpers
  layout.js         - shared page header/footer HTML
  schema.sql        - database schema (Postgres)
public/style.css
render.yaml         - optional Render Blueprint config
```
