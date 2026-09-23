require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const { DateTime } = require('luxon');

const { pool, query, ensureSeeded } = require('./lib/db');
const { requireLogin, requireAdmin, attemptLogin, currentUser, actorLabel } = require('./lib/auth');
const { getSetting, setSetting, logRun } = require('./lib/settings');
const { HydrawiseClient } = require('./lib/hydrawise');
const {
  TZ, DAY_LABELS, e, csrfToken, csrfField, requireCsrf,
  daysMaskFromArray, daysMaskToLabels, nextRunTs, fmtTime, fmtDayTime, fmtLogTime,
} = require('./lib/helpers');
const { header, footer, flash } = require('./lib/layout');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.set('trust proxy', 1); // Render sits behind a proxy; needed for secure cookies

app.use(session({
  store: new pgSession({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 12,
  },
}));

// ---------------------------------------------------------------- helpers

async function zoneById(id) {
  const { rows } = await query('SELECT * FROM zones WHERE id = $1', [id]);
  return rows[0];
}

function wantsAdmin(req) {
  return currentUser(req) && currentUser(req).role === 'admin';
}

// ---------------------------------------------------------------- auth pages

app.get('/', (req, res) => res.redirect(currentUser(req) ? '/dashboard' : '/login'));

app.get('/login', async (req, res) => {
  if (currentUser(req)) return res.redirect('/dashboard');
  res.send(await loginPage(req));
});

app.post('/login', requireCsrf, async (req, res) => {
  if (currentUser(req)) return res.redirect('/dashboard');
  const { username, password } = req.body;
  if (await attemptLogin(req, username || '', password || '')) {
    return res.redirect('/dashboard');
  }
  res.send(await loginPage(req, 'Incorrect username or password.'));
});

/**
 * Only shows the default-login hint while the admin account genuinely
 * still has the seeded 'changeme123' password. Previously this text was
 * always shown, meaning it kept advertising a live, working password to
 * every visitor indefinitely — even to people who never needed the
 * first-time-setup hint at all. Once the admin password is changed from
 * the Users page, this check fails and the hint disappears for good.
 */
async function loginPage(req, error) {
  let showDefaultHint = false;
  try {
    const { rows } = await query('SELECT password_hash FROM users WHERE username = $1', ['admin']);
    if (rows[0]) showDefaultHint = await bcrypt.compare('changeme123', rows[0].password_hash);
  } catch (e) {
    console.error('Failed to check default-credential status for login hint:', e.message);
    // Fail closed — if we can't confirm the password was changed, don't
    // keep advertising it.
    showDefaultHint = false;
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Log in · McDonald Hills GC Irrigation Scheduler</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/style.css">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#17332a">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Irrigation">
</head>
<body>
<div class="login-wrap">
  <form class="login-card" method="post" action="/login">
    <h1>McDonald Hills GC</h1>
    <p class="sub">Irrigation Scheduler</p>
    ${error ? `<div class="flash flash-error">${e(error)}</div>` : ''}
    ${csrfField(req)}
    <div class="form-row"><label for="username">Username</label><input type="text" id="username" name="username" required autofocus></div>
    <div class="form-row"><label for="password">Password</label><input type="password" id="password" name="password" required></div>
    <button type="submit" style="width:100%">Log in</button>
    <p class="muted" style="font-size:0.78rem;margin-top:1rem">
      ${showDefaultHint ? `First time setup? Default logins are <strong>admin</strong> / <strong>changeme123</strong> and
      <strong>crew</strong> / <strong>changeme123</strong> — change these immediately from the Users page.` : ''}
    </p>
  </form>
</div>
</body>
</html>`;
}

app.post('/logout', requireCsrf, (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.get('/account', requireLogin, async (req, res) => {
  const u = currentUser(req);
  let html = await header(req, { title: 'Your Account' });
  html += `
<div class="page-title">
  <div>
    <h1>Your Account</h1>
    ${u.must_change_password ? '<p>For security, please set a new password before continuing — you\'re currently on the shared default password.</p>' : ''}
  </div>
</div>
<div class="card" style="max-width:420px">
  <form method="post" action="/account">
    ${csrfField(req)}
    <div class="form-row"><label>Current password</label><input type="password" name="current_password" required autofocus></div>
    <div class="form-row"><label>New password</label><input type="password" name="new_password" minlength="8" required></div>
    <div class="form-row"><label>Confirm new password</label><input type="password" name="new_password2" minlength="8" required></div>
    <button type="submit">Update Password</button>
  </form>
</div>` + footer();
  res.send(html);
});

app.post('/account', requireLogin, requireCsrf, async (req, res) => {
  const u = currentUser(req);
  const { current_password, new_password, new_password2 } = req.body;
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [u.id]);
  const row = rows[0];

  let error = null;
  if (!(await bcrypt.compare(current_password || '', row.password_hash))) {
    error = 'Current password is incorrect.';
  } else if ((new_password || '').length < 8) {
    error = 'New password must be at least 8 characters.';
  } else if (new_password !== new_password2) {
    error = 'New passwords do not match.';
  }

  if (error) {
    let html = await header(req, { title: 'Your Account' });
    html += `<div class="page-title"><h1>Your Account</h1></div>
    <div class="card" style="max-width:420px">
      <div class="flash flash-error">${e(error)}</div>
      <form method="post" action="/account">
        ${csrfField(req)}
        <div class="form-row"><label>Current password</label><input type="password" name="current_password" required autofocus></div>
        <div class="form-row"><label>New password</label><input type="password" name="new_password" minlength="8" required></div>
        <div class="form-row"><label>Confirm new password</label><input type="password" name="new_password2" minlength="8" required></div>
        <button type="submit">Update Password</button>
      </form>
    </div>` + footer();
    return res.send(html);
  }

  const hash = await bcrypt.hash(new_password, 10);
  await query('UPDATE users SET password_hash = $1, must_change_password = false WHERE id = $2', [hash, u.id]);
  req.session.user.must_change_password = false;
  flash(req, 'success', 'Password updated.');
  res.redirect('/dashboard');
});

// Lightweight JSON status feed the dashboard/manual pages poll on an
// interval (see footer()'s script) so zone status updates live in place
// instead of requiring a manual pull-to-refresh/reload.
app.get('/api/zone-status', requireLogin, async (req, res) => {
  const { rows: zones } = await query('SELECT * FROM zones ORDER BY number');
  const hc = await HydrawiseClient.create();
  const out = [];
  for (const z of zones) {
    const status = await hc.zoneStatus(z);
    out.push({ id: z.id, state: status.state, detail: status.detail || null, endsAt: status.endsAt || null });
  }
  res.json({ zones: out });
});

// ---------------------------------------------------------------- dashboard

app.get('/dashboard', requireLogin, async (req, res) => {
  const u = req.user;
  const { rows: zones } = await query('SELECT * FROM zones ORDER BY number');
  const { rows: programs } = await query('SELECT * FROM programs ORDER BY name');
  const hc = await HydrawiseClient.create();

  const upcoming = programs
    .map((p) => ({ program: p, ts: nextRunTs(p) }))
    .filter((x) => x.ts)
    .sort((a, b) => a.ts - b.ts)
    .slice(0, 6);

  const quickRunPrograms = programs.filter((p) => p.program_type === 'on_demand' && p.enabled);
  let quickRunHtml = '';
  if (quickRunPrograms.length) {
    const buttons = quickRunPrograms.map((p) => `
      <form method="post" action="/programs/${p.id}/run" style="display:inline-block;margin:0 0.5rem 0.5rem 0">
        ${csrfField(req)}
        <button type="submit">${e(p.name)}</button>
      </form>`).join('');
    quickRunHtml = `
<div class="card">
  <h2 style="margin-top:0;font-size:1rem">Quick run</h2>
  <p class="muted" style="margin-top:-0.4rem">One click starts that program's zones right now — no timer, no waiting.</p>
  ${buttons}
</div>`;
  }

  let upcomingRows = '';
  for (const row of upcoming) {
    const { rows: zr } = await query(
      `SELECT z.name FROM program_zones pz JOIN zones z ON z.id = pz.zone_id
       WHERE pz.program_id = $1 ORDER BY pz.sort_order`,
      [row.program.id]
    );
    const names = zr.map((r) => r.name).join(', ') || '—';
    upcomingRows += `<tr><td data-label="When">${e(fmtDayTime(row.ts))}</td><td data-label="Program">${e(row.program.name)}</td><td data-label="Zones" class="muted">${e(names)}</td></tr>`;
  }

  let zoneCards = '';
  for (const z of zones) {
    const status = await hc.zoneStatus(z);
    zoneCards += `
    <div class="zone-card" data-zone-id="${z.id}">
      <div class="zone-num">Zone ${z.number}</div>
      <h3>${e(z.name)}</h3>
      <span class="status-pill status-${status.state} js-status-pill">${status.state[0].toUpperCase() + status.state.slice(1)}</span>
      <div class="muted js-status-detail countdown" style="font-size:0.8rem" data-ends-at="${status.endsAt || ''}">${status.state === 'running' && status.endsAt ? '' : e(status.detail || '')}</div>
      ${!z.enabled ? '<div class="muted" style="font-size:0.78rem">Disabled</div>' : ''}
    </div>`;
  }

  let html = await header(req, { title: 'Dashboard', activeNav: 'dashboard' });
  html += `
<div class="page-title">
  <div>
    <h1>Dashboard</h1>
    <p>24 zones on the Pro-HC controller · ${programs.length} program${programs.length === 1 ? '' : 's'} configured</p>
  </div>
  <a href="/manual" class="btn">Open Manual Control</a>
</div>
${quickRunHtml}
<div class="card">
  <h2 style="margin-top:0;font-size:1rem">Upcoming scheduled runs</h2>
  ${!upcoming.length
    ? `<p class="empty-state">No upcoming runs. ${u.role === 'admin' ? '<a href="/programs">Create a program</a> to get started.' : 'Ask an admin to set up a watering program.'}</p>`
    : `<table class="responsive"><thead><tr><th>When</th><th>Program</th><th>Zones</th></tr></thead><tbody>${upcomingRows}</tbody></table>`}
</div>
<h2 style="font-size:1rem">Zones</h2>
<div class="grid">${zoneCards}</div>` + footer();

  res.send(html);
});

// ---------------------------------------------------------------- manual control

app.get('/manual', requireLogin, async (req, res) => {
  res.send(await manualPage(req));
});

app.post('/manual', requireLogin, requireCsrf, async (req, res) => {
  const hc = await HydrawiseClient.create();
  const actor = actorLabel(req);
  const action = req.body.action;

  if (action === 'runall' || action === 'stopall') {
    const { rows: zones } = await query('SELECT * FROM zones WHERE enabled = true ORDER BY number');
    const minutes = Math.max(1, parseInt(req.body.minutes, 10) || 10);

    if (action === 'runall') {
      if (await isSequenceBusy()) {
        flash(req, 'error', "Can't start Run All yet — another watering sequence is still running. Wait for it to finish, or use Stop All first.");
        return res.redirect('/manual');
      }
      // Zones water ONE AT A TIME, in sequence — see the comment on
      // runProgramZones() below for why (shared water pressure, and
      // Hydrawise's real rate limit). "Run All" starts zone 1 now,
      // zone 2 once zone 1's `minutes` have elapsed, and so on.
      dispatchSequentialRuns(zones.map((z) => ({ zone: z, minutes })), hc, actor, null);
    } else {
      // Stop All used to have NO guard against being clicked more than
      // once — every click queued a full stop-sequence (one command per
      // enabled zone, 35s apart) with nothing stopping several of those
      // sequences from piling up on top of each other. Six Stop All
      // clicks in under a minute once queued 100+ stop commands into the
      // same few minutes, which instantly blew through Hydrawise's real
      // limit of 10 requests per 5 minutes — and once THAT happened,
      // every other request (including legitimate scheduled Greens/
      // Morning runs) started failing with the same rate-limit error too,
      // for the better part of 20 minutes. This is almost certainly what
      // actually happened to zones that appeared to silently skip earlier
      // — their Run command hit this same rate limit and errored out
      // before ever reaching the relay.
      if (await hasPendingStops()) {
        flash(req, 'error', 'Already stopping zones — give it a minute rather than clicking Stop All again (repeated clicks queue duplicate stop commands and can trip Hydrawise\'s rate limit).');
        return res.redirect('/manual');
      }
      // Stop has no natural "duration" to space by, but the same rate
      // limit still applies — space stops out safely instead of firing
      // all of them in the same instant.
      dispatchSequentialStops(zones, hc, actor);
    }

    await logRun(null, null, action, action === 'runall' ? minutes : null, actor, 'success', 'All enabled zones');
    flash(req, 'success', action === 'runall'
      ? `Starting all zones in sequence, ${minutes} minutes each.`
      : 'Stopping all zones (spaced out to stay within Hydrawise\'s rate limit).');
    return res.redirect('/manual');
  }

  const zone = await zoneById(parseInt(req.body.zone_id, 10));
  if (!zone) {
    flash(req, 'error', 'Zone not found.');
    return res.redirect('/manual');
  }

  switch (action) {
    case 'run': {
      const minutes = Math.max(1, Math.min(180, parseInt(req.body.minutes, 10) || 10));
      const r = await hc.runZone(zone, minutes, actor);
      flash(req, r.ok ? 'success' : 'error', `${zone.name}: ${r.ok ? `running for ${minutes} min.` : r.message}`);
      break;
    }
    case 'stop': {
      const r = await hc.stopZone(zone, actor);
      flash(req, r.ok ? 'success' : 'error', `${zone.name}: ${r.ok ? 'stopped.' : r.message}`);
      break;
    }
    case 'suspend': {
      const days = Math.max(1, parseInt(req.body.days, 10) || 1);
      const until = Date.now() + days * 86400000;
      const r = await hc.suspendZone(zone, until, actor);
      flash(req, r.ok ? 'success' : 'error', `${zone.name}: ${r.ok ? `suspended for ${days} day(s).` : r.message}`);
      break;
    }
    case 'resume': {
      const r = await hc.resumeZone(zone, actor);
      flash(req, r.ok ? 'success' : 'error', `${zone.name}: ${r.ok ? 'resumed.' : r.message}`);
      break;
    }
  }
  res.redirect('/manual');
});

async function manualPage(req) {
  const { rows: zones } = await query('SELECT * FROM zones ORDER BY number');
  const hc = await HydrawiseClient.create();
  const busy = await isSequenceBusy();
  const stopping = await hasPendingStops();

  let zoneCards = '';
  for (const z of zones) {
    const status = await hc.zoneStatus(z);
    zoneCards += `
    <div class="zone-card" data-zone-id="${z.id}">
      <div class="zone-num">Zone ${z.number}</div>
      <h3>${e(z.name)}</h3>
      <span class="status-pill status-${status.state} js-status-pill">${status.state[0].toUpperCase() + status.state.slice(1)}</span>
      <div class="muted js-status-detail countdown" style="font-size:0.8rem" data-ends-at="${status.endsAt || ''}">${status.state === 'running' && status.endsAt ? '' : e(status.detail || '')}</div>
      <div class="zone-actions">
        <form method="post" action="/manual" style="display:flex;gap:0.3rem;align-items:center">
          ${csrfField(req)}
          <input type="hidden" name="zone_id" value="${z.id}">
          <input type="number" name="minutes" min="1" max="180" value="10" style="width:4.2rem" title="Minutes">
          <button type="submit" name="action" value="run" class="small" ${z.enabled ? '' : 'disabled'}>Run</button>
        </form>
        <form method="post" action="/manual">
          ${csrfField(req)}
          <input type="hidden" name="zone_id" value="${z.id}">
          <button type="submit" name="action" value="stop" class="small secondary">Stop</button>
        </form>
        ${status.state === 'suspended' ? `
        <form method="post" action="/manual">
          ${csrfField(req)}
          <input type="hidden" name="zone_id" value="${z.id}">
          <button type="submit" name="action" value="resume" class="small secondary">Resume</button>
        </form>` : `
        <form method="post" action="/manual" style="display:flex;gap:0.3rem;align-items:center">
          ${csrfField(req)}
          <input type="hidden" name="zone_id" value="${z.id}">
          <input type="number" name="days" min="1" max="30" value="1" style="width:3.6rem" title="Days">
          <button type="submit" name="action" value="suspend" class="small secondary">Suspend</button>
        </form>`}
      </div>
    </div>`;
  }

  let html = await header(req, { title: 'Manual Control', activeNav: 'manual' });
  html += `
<div class="page-title">
  <div><h1>Manual Control</h1><p>Start, stop, or suspend any zone right now — useful for spot-watering or working around a program.</p></div>
</div>
${busy || stopping ? `<div class="flash" style="background:var(--green-100);color:var(--green-700)">${stopping ? 'Stop All is still working through its zone list — clicking it again will queue duplicate stop commands instead of speeding anything up.' : 'A watering sequence is currently running — Run Now/Run All will be blocked until it finishes, to avoid two sequences colliding.'}</div>` : ''}
<div class="card">
  <h2 style="margin-top:0;font-size:1rem">All zones</h2>
  <form method="post" action="/manual" style="display:flex;gap:0.6rem;align-items:end;flex-wrap:wrap">
    ${csrfField(req)}
    <div class="form-row" style="max-width:140px;margin-bottom:0"><label>Minutes (for Run All)</label><input type="number" name="minutes" min="1" max="180" value="10"></div>
    <button type="submit" name="action" value="runall">Run All</button>
    <button type="submit" name="action" value="stopall" class="secondary">Stop All</button>
  </form>
</div>
<div class="grid">${zoneCards}</div>` + footer();
  return html;
}

// ---------------------------------------------------------------- hot list

app.get('/hotlist', requireLogin, async (req, res) => {
  res.send(await hotListPage(req));
});

// JSON feed the Hot List page polls so the queue and each zone's status
// update live as zones start, finish, and get added, without a manual
// reload — same pattern as /api/zone-status.
app.get('/api/hotlist/status', requireLogin, async (req, res) => {
  const items = await hotListQueueView();
  res.json({
    queue: items.map((it) => ({
      zoneId: it.zone.id, name: it.zone.name, number: it.zone.number,
      minutes: it.minutes, status: it.status, endsAt: it.endsAt, retryAt: it.retryAt || null,
    })),
  });
});

app.post('/api/hotlist/add', requireLogin, requireCsrf, async (req, res) => {
  const zone = await zoneById(parseInt(req.body.zone_id, 10));
  if (!zone) return res.status(404).json({ ok: false, message: 'Zone not found.' });
  if (!zone.enabled) return res.status(400).json({ ok: false, message: `${zone.name} is disabled.` });
  const minutes = Math.max(1, Math.min(180, parseInt(req.body.minutes, 10) || 5));
  const actor = actorLabel(req);
  let result;
  try {
    result = await addToHotList(zone, minutes, actor);
  } catch (err) {
    console.error('[hotlist add] failed:', err);
    result = { ok: false, message: 'Something went wrong adding that zone. Try again.' };
  }
  // Logged as 'queued', NOT 'run' — this records the ADD action itself
  // (useful audit trail: who tapped what, and when), but must never be
  // mistaken for an actual physical watering event. currentlyRunningZoneId()
  // and isSequenceBusy() both look for the most recent successful 'run'
  // entry to figure out what's ACTUALLY running right now; logging every
  // Hot List tap as 'run' meant a zone that was merely queued (not yet
  // physically started) could outrank the real running zone if it was
  // added more recently — exactly what happened when zone 19 was added
  // after hole 9 and briefly showed as "Running" in its place. The real
  // physical start/stop still gets its own accurate 'run'/'stop' log
  // entry from hc.runZone()/hc.stopZone() at the moment it actually fires
  // — this is purely an audit note for the add itself. It also used to
  // count toward the internal rate-limit throttle (_nearRateLimit() counts
  // 'run'/'stop' rows) even for zones that hadn't reached Hydrawise yet —
  // 'queued' is correctly excluded from that count too.
  await logRun(zone.id, null, 'queued', minutes, actor, result.ok ? 'success' : 'error', `Hot List: ${result.message}`);
  res.json(result);
});

// Mirrors Manual Control's Stop All exactly (same guard, same sequential-
// stop dispatch), plus clears anything still queued to fire NEXT in the
// Hot List's forward queue — otherwise a zone already queued could still
// start a few seconds after Stop All was tapped.
app.post('/api/hotlist/stopall', requireLogin, requireCsrf, async (req, res) => {
  const actor = actorLabel(req);
  if (await hasPendingStops()) {
    return res.json({ ok: false, message: 'Already stopping zones — give it a moment.' });
  }
  await query(`DELETE FROM pending_zone_runs WHERE action = 'run'`);
  const { rows: zones } = await query('SELECT * FROM zones WHERE enabled = true ORDER BY number');
  const hc = await HydrawiseClient.create();
  dispatchSequentialStops(zones, hc, actor);
  await logRun(null, null, 'stopall', null, actor, 'success', 'Hot List: stop all');
  res.json({ ok: true, message: 'Stopping all zones.' });
});

function hotListItemHtml(it) {
  const label = it.status === 'running' ? 'Running' : it.status === 'retrying' ? 'Delayed' : 'Queued';
  const pillClass = it.status === 'running' ? 'status-running' : it.status === 'retrying' ? 'status-suspended' : 'status-idle';
  let detail;
  if (it.status === 'running' && it.endsAt) {
    detail = `<span class="muted js-hotlist-countdown" data-ends-at="${it.endsAt}"></span>`;
  } else if (it.status === 'retrying' && it.retryAt) {
    detail = `<span class="muted">rate limit — retrying at ${e(fmtTime(it.retryAt))}</span>`;
  } else {
    detail = `<span class="muted">${it.minutes} min</span>`;
  }
  return `
    <div class="hotlist-row" data-zone-id="${it.zone.id}">
      <span class="status-pill ${pillClass}">${label}</span>
      <strong>Z${it.zone.number} ${e(it.zone.name)}</strong>
      ${detail}
    </div>`;
}

async function hotListPage(req) {
  const { rows: zones } = await query('SELECT * FROM zones ORDER BY number');
  const queue = await hotListQueueView();

  const queueHtml = queue.length
    ? queue.map(hotListItemHtml).join('')
    : '<p class="empty-state" id="hotlist-empty">Nothing running or queued. Tap a green below to start it.</p>';

  let zoneCards = '';
  for (const z of zones) {
    zoneCards += `
    <div class="zone-card">
      <div class="zone-num">Zone ${z.number}</div>
      <h3>${e(z.name)}</h3>
      <div class="zone-actions" style="display:flex;gap:0.3rem;align-items:center">
        <input type="number" class="js-hotlist-minutes" min="1" max="180" value="5" style="width:4.2rem" title="Minutes" ${z.enabled ? '' : 'disabled'}>
        <button type="button" class="small js-hotlist-add" data-zone-id="${z.id}" ${z.enabled ? '' : 'disabled'}>Add</button>
      </div>
    </div>`;
  }

  let html = await header(req, { title: 'Hot List', activeNav: 'hotlist' });
  html += `
<div class="page-title">
  <div><h1>Hot List</h1><p>Walking the course and spotting hot greens? Tap one to add it to the running queue — it joins the line without stopping what's already watering.</p></div>
</div>
<div class="card">
  <h2 style="margin-top:0;font-size:1rem">Current queue</h2>
  <div id="hotlist-queue">${queueHtml}</div>
  <button type="button" id="hotlist-stopall-btn" class="secondary" style="margin-top:0.75rem">Stop All</button>
</div>
<div class="grid">${zoneCards}</div>
<script>
(function() {
  var csrf = ${JSON.stringify(csrfToken(req))};

  function fmt(ms) {
    if (ms <= 0) return 'finishing\\u2026';
    var totalSec = Math.floor(ms / 1000);
    var m = Math.floor(totalSec / 60);
    var s = totalSec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s + ' left';
  }

  function tickCountdowns() {
    document.querySelectorAll('.js-hotlist-countdown[data-ends-at]').forEach(function(el) {
      var endsAt = parseInt(el.getAttribute('data-ends-at'), 10);
      if (!endsAt) return;
      el.textContent = fmt(endsAt - Date.now());
    });
  }
  tickCountdowns();
  setInterval(tickCountdowns, 1000);

  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body,
    }).then(function(r) { return r.json(); });
  }

  document.querySelectorAll('.js-hotlist-add').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var zoneId = btn.getAttribute('data-zone-id');
      var minutesInput = btn.parentElement.querySelector('.js-hotlist-minutes');
      var minutes = minutesInput ? minutesInput.value : 5;
      btn.disabled = true;
      var originalText = btn.textContent;
      btn.textContent = 'Adding\\u2026';
      post('/api/hotlist/add', 'csrf=' + encodeURIComponent(csrf) + '&zone_id=' + encodeURIComponent(zoneId) + '&minutes=' + encodeURIComponent(minutes))
        .then(function(data) {
          btn.textContent = data.ok ? 'Added \\u2713' : 'Failed';
          if (!data.ok) console.error(data.message);
          refreshQueue();
        })
        .catch(function() { btn.textContent = 'Failed'; })
        .finally(function() {
          setTimeout(function() { btn.disabled = false; btn.textContent = originalText; }, 1200);
        });
    });
  });

  var stopBtn = document.getElementById('hotlist-stopall-btn');
  if (stopBtn) {
    stopBtn.addEventListener('click', function() {
      stopBtn.disabled = true;
      post('/api/hotlist/stopall', 'csrf=' + encodeURIComponent(csrf))
        .then(function() { refreshQueue(); })
        .finally(function() { setTimeout(function() { stopBtn.disabled = false; }, 1500); });
    });
  }

  function fmtClockTime(ms) {
    var d = new Date(ms);
    var h = d.getHours();
    var m = d.getMinutes();
    var ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12; if (h === 0) h = 12;
    return h + ':' + (m < 10 ? '0' : '') + m + ' ' + ampm;
  }

  function renderQueue(items) {
    var container = document.getElementById('hotlist-queue');
    if (!container) return;
    if (!items.length) {
      container.innerHTML = '<p class="empty-state" id="hotlist-empty">Nothing running or queued. Tap a green below to start it.</p>';
      return;
    }
    container.innerHTML = items.map(function(it) {
      var pillClass = it.status === 'running' ? 'status-running' : (it.status === 'retrying' ? 'status-suspended' : 'status-idle');
      var label = it.status === 'running' ? 'Running' : (it.status === 'retrying' ? 'Delayed' : 'Queued');
      var detail;
      if (it.status === 'running' && it.endsAt) {
        detail = '<span class="muted js-hotlist-countdown" data-ends-at="' + it.endsAt + '"></span>';
      } else if (it.status === 'retrying' && it.retryAt) {
        detail = '<span class="muted">rate limit \\u2014 retrying at ' + fmtClockTime(it.retryAt) + '</span>';
      } else {
        detail = '<span class="muted">' + it.minutes + ' min</span>';
      }
      return '<div class="hotlist-row" data-zone-id="' + it.zoneId + '">' +
        '<span class="status-pill ' + pillClass + '">' + label + '</span>' +
        '<strong>Z' + it.number + ' ' + it.name.replace(/</g, '&lt;') + '</strong>' +
        detail + '</div>';
    }).join('');
    tickCountdowns();
  }

  function refreshQueue() {
    fetch('/api/hotlist/status', { headers: { 'Accept': 'application/json' } })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) { if (data && data.queue) renderQueue(data.queue); })
      .catch(function() { /* next poll retries */ });
  }
  refreshQueue();
  setInterval(refreshQueue, 5000);
  document.addEventListener('visibilitychange', function() {
    if (!document.hidden) refreshQueue();
  });
})();
</script>` + footer();
  return html;
}

// ---------------------------------------------------------------- programs

app.get('/programs', requireLogin, async (req, res) => {
  res.send(await programsPage(req));
});

app.post('/programs', requireAdmin, requireCsrf, async (req, res) => {
  const u = req.user;
  const action = req.body.action;

  if (action === 'delete') {
    try {
      await query('DELETE FROM programs WHERE id = $1', [parseInt(req.body.id, 10)]);
      flash(req, 'success', 'Program deleted.');
    } catch (err) {
      // Belt-and-suspenders alongside the schema fix (run_log/
      // pending_zone_runs now SET NULL instead of blocking the delete) —
      // if a delete ever fails for some OTHER reason, show it plainly
      // instead of throwing an unhandled error that used to crash the
      // whole process.
      console.error('[programs delete] failed:', err);
      flash(req, 'error', "Couldn't delete that program — nothing was changed. " + (err.message || ''));
    }
    return res.redirect('/programs');
  }

  if (action === 'save') {
    const id = parseInt(req.body.id, 10) || 0;
    const name = (req.body.name || '').trim();
    const programType = req.body.program_type === 'on_demand' ? 'on_demand' : 'scheduled';
    // On-demand programs never run on a timer, so start_time/days are meaningless —
    // store harmless placeholders regardless of what the (hidden) fields contained.
    const startTime = programType === 'on_demand' ? '00:00' : (req.body.start_time || '06:00');
    const days = Array.isArray(req.body.days) ? req.body.days : (req.body.days ? [req.body.days] : []);
    const mask = programType === 'on_demand' ? 0 : daysMaskFromArray(days);
    const enabled = req.body.enabled ? true : false;
    const seasonal = Math.max(10, Math.min(200, parseInt(req.body.seasonal_adjust_pct, 10) || 100));
    let zoneIds = req.body.zone_id || [];
    let durations = req.body.duration || [];
    if (!Array.isArray(zoneIds)) zoneIds = [zoneIds];
    if (!Array.isArray(durations)) durations = [durations];

    if (!name) {
      flash(req, 'error', 'Program name is required.');
      return res.redirect('/programs');
    }

    const client = await pool.connect();
    let programId = id;
    try {
      await client.query('BEGIN');
      if (id) {
        await client.query(
          `UPDATE programs SET name=$1, start_time=$2, days_mask=$3, enabled=$4, seasonal_adjust_pct=$5, program_type=$6, updated_at=now() WHERE id=$7`,
          [name, startTime, mask, enabled, seasonal, programType, id]
        );
        await client.query('DELETE FROM program_zones WHERE program_id = $1', [id]);
      } else {
        const { rows } = await client.query(
          `INSERT INTO programs (name, start_time, days_mask, enabled, seasonal_adjust_pct, created_by, program_type) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [name, startTime, mask, enabled, seasonal, u.id, programType]
        );
        programId = rows[0].id;
      }
      let order = 0;
      for (let i = 0; i < zoneIds.length; i++) {
        const zid = parseInt(zoneIds[i], 10);
        const dur = Math.max(1, parseInt(durations[i], 10) || 10);
        if (zid > 0) {
          await client.query(
            'INSERT INTO program_zones (program_id, zone_id, duration_minutes, sort_order) VALUES ($1,$2,$3,$4)',
            [programId, zid, dur, order++]
          );
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    flash(req, 'success', `Program "${name}" saved.`);
    return res.redirect('/programs');
  }

  res.redirect('/programs');
});

// Runs a program's zones immediately, regardless of type — this is how
// on-demand programs are started (crew or admin, no schedule involved), and
// it also lets a scheduled program be run out-of-band if needed.
app.post('/programs/:id/run', requireLogin, requireCsrf, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { rows } = await query('SELECT * FROM programs WHERE id = $1', [id]);
  const program = rows[0];
  if (!program) {
    flash(req, 'error', 'Program not found.');
    return res.redirect('/programs');
  }
  if (!program.enabled) {
    flash(req, 'error', `"${program.name}" is disabled — ask an admin to enable it first.`);
    return res.redirect('/programs');
  }
  const hc = await HydrawiseClient.create();
  if (await isSequenceBusy()) {
    flash(req, 'error', `Can't start "${program.name}" yet — another watering sequence is still running. Wait for it to finish, or use Stop All in Manual Control.`);
    return res.redirect('/programs');
  }
  const count = await runProgramZones(program, hc, actorLabel(req));
  if (count === 0) {
    flash(req, 'error', `"${program.name}" has no zones configured yet.`);
  } else {
    flash(req, 'success', `Started "${program.name}" (${count} zone${count === 1 ? '' : 's'}).`);
  }
  res.redirect('/programs');
});

async function programsPage(req) {
  const u = req.user;
  const isAdmin = u.role === 'admin';
  const editId = parseInt(req.query.edit, 10) || 0;
  const isNew = 'new' in req.query;

  let editing = null;
  let editingZones = [];
  if (isAdmin && (editId || isNew)) {
    if (editId) {
      const { rows } = await query('SELECT * FROM programs WHERE id = $1', [editId]);
      editing = rows[0];
      const zr = await query('SELECT * FROM program_zones WHERE program_id = $1 ORDER BY sort_order', [editId]);
      editingZones = zr.rows;
    } else {
      editing = { id: 0, name: '', start_time: '06:00', days_mask: 0, enabled: true, seasonal_adjust_pct: 100, program_type: 'scheduled' };
    }
  }

  const { rows: allZones } = await query('SELECT * FROM zones WHERE enabled = true ORDER BY number');
  const { rows: programs } = await query('SELECT * FROM programs ORDER BY name');

  let editFormHtml = '';
  if (isAdmin && editing) {
    const zoneRows = allZones.map((z) => {
      const existing = editingZones.find((ez) => ez.zone_id === z.id);
      return `
      <tr>
        <td><input type="checkbox" onchange="document.getElementById('dur-${z.id}').disabled = !this.checked; document.getElementById('zid-${z.id}').disabled = !this.checked;" ${existing ? 'checked' : ''}></td>
        <td>Zone ${z.number} — ${e(z.name)}</td>
        <td>
          <input type="hidden" id="zid-${z.id}" name="zone_id[]" value="${z.id}" ${existing ? '' : 'disabled'}>
          <input type="number" id="dur-${z.id}" name="duration[]" min="1" max="180" value="${existing ? existing.duration_minutes : 10}" ${existing ? '' : 'disabled'}>
        </td>
      </tr>`;
    }).join('');

    const dayPills = DAY_LABELS.map((label, i) => {
      const checked = editing.days_mask & (1 << i);
      return `<label class="day-pill ${checked ? 'checked' : ''}">
        <input type="checkbox" name="days[]" value="${i}" ${checked ? 'checked' : ''} onclick="this.parentElement.classList.toggle('checked')">${label}</label>`;
    }).join('');

    const isOnDemand = editing.program_type === 'on_demand';

    editFormHtml = `
    <div class="card">
      <h2 style="margin-top:0;font-size:1rem">${editing.id ? 'Edit' : 'New'} Program</h2>
      <form method="post" action="/programs">
        ${csrfField(req)}
        <input type="hidden" name="action" value="save">
        <input type="hidden" name="id" value="${editing.id}">
        <div class="form-row"><label>Program name</label><input type="text" name="name" value="${e(editing.name)}" placeholder="e.g. Fairways - Morning" required></div>
        <div class="form-row">
          <label>Type</label>
          <div class="checkbox-row">
            <label class="type-pill ${isOnDemand ? '' : 'checked'}">
              <input type="radio" name="program_type" value="scheduled" ${isOnDemand ? '' : 'checked'}
                onclick="document.getElementById('scheduled-fields').style.display='';this.closest('.checkbox-row').querySelectorAll('.type-pill').forEach(l=>l.classList.remove('checked'));this.parentElement.classList.add('checked')"> Scheduled</label>
            <label class="type-pill ${isOnDemand ? 'checked' : ''}">
              <input type="radio" name="program_type" value="on_demand" ${isOnDemand ? 'checked' : ''}
                onclick="document.getElementById('scheduled-fields').style.display='none';this.closest('.checkbox-row').querySelectorAll('.type-pill').forEach(l=>l.classList.remove('checked'));this.parentElement.classList.add('checked')"> Run on demand</label>
          </div>
          <p class="muted" style="font-size:0.82rem;margin:0.35rem 0 0">Scheduled programs run automatically at a set time on chosen days. On-demand programs don't run on their own — anyone can hit <strong>Run Now</strong> on the Programs page to start them instantly. Good for hot spots that can't be on a fixed timer because golfers might be on the green.</p>
        </div>
        <div id="scheduled-fields" style="${isOnDemand ? 'display:none' : ''}">
          <div class="form-row"><label>Start time</label><input type="time" name="start_time" value="${e(editing.start_time)}"></div>
          <div class="form-row"><label>Days</label><div class="checkbox-row">${dayPills}</div></div>
        </div>
        <div class="form-row"><label>Seasonal adjustment (% of normal run time)</label><input type="number" name="seasonal_adjust_pct" min="10" max="200" value="${editing.seasonal_adjust_pct}"></div>
        <div class="form-row"><label><input type="checkbox" name="enabled" ${editing.enabled ? 'checked' : ''} style="width:auto"> Enabled</label></div>
        <div class="form-row">
          <label>Zones &amp; run time (minutes each)</label>
          <table><thead><tr><th style="width:2rem"></th><th>Zone</th><th style="width:8rem">Minutes</th></tr></thead><tbody>${zoneRows}</tbody></table>
        </div>
        <button type="submit">Save Program</button>
        <a href="/programs" class="btn secondary">Cancel</a>
      </form>
    </div>`;
  }

  let listRows = '';
  for (const p of programs) {
    const zr = await query(
      `SELECT z.number, z.name, pz.duration_minutes FROM program_zones pz JOIN zones z ON z.id=pz.zone_id WHERE pz.program_id=$1 ORDER BY pz.sort_order`,
      [p.id]
    );
    const zoneSummary = zr.rows.map((r) => `Z${r.number} (${r.duration_minutes}m)`).join(', ') || '—';
    const scheduleCells = p.program_type === 'on_demand'
      ? `<td data-label="Schedule" colspan="2" class="muted">On demand</td>`
      : `<td data-label="Start">${e(fmtTime(DateTime.fromFormat(p.start_time, 'HH:mm', { zone: TZ }).toMillis()))}</td><td data-label="Days" class="muted">${e(daysMaskToLabels(p.days_mask))}</td>`;
    listRows += `
    <tr>
      <td data-label="Name">${e(p.name)}</td>
      ${scheduleCells}
      <td data-label="Zones" class="muted">${e(zoneSummary)}</td>
      <td data-label="Status">${p.enabled ? 'Enabled' : '<span class="muted">Disabled</span>'}</td>
      <td class="right">
        ${p.enabled ? `
        <form method="post" action="/programs/${p.id}/run" style="display:inline">
          ${csrfField(req)}
          <button type="submit" class="small">Run Now</button>
        </form>` : ''}
        ${isAdmin ? `
        <a href="/programs?edit=${p.id}" class="btn small secondary">Edit</a>
        <form method="post" action="/programs" style="display:inline" onsubmit="return confirm('Delete this program?');">
          ${csrfField(req)}<input type="hidden" name="action" value="delete"><input type="hidden" name="id" value="${p.id}">
          <button type="submit" class="small danger">Delete</button>
        </form>` : ''}
      </td>
    </tr>`;
  }

  let html = await header(req, { title: 'Programs', activeNav: 'programs' });
  html += `
<div class="page-title">
  <div><h1>Watering Programs</h1><p>Scheduled programs run automatically; on-demand programs wait for someone to click Run Now.</p></div>
  ${isAdmin && !editing ? '<a href="/programs?new=1" class="btn">+ New Program</a>' : ''}
</div>
${editFormHtml}
<div class="card">
  ${!programs.length
    ? `<p class="empty-state">No programs yet. ${isAdmin ? '<a href="/programs?new=1">Create your first program</a>.' : 'Ask an admin to set one up.'}</p>`
    : `<table class="responsive"><thead><tr><th>Name</th><th>Start</th><th>Days</th><th>Zones</th><th>Status</th><th></th></tr></thead><tbody>${listRows}</tbody></table>`}
</div>` + footer();
  return html;
}

// ---------------------------------------------------------------- zones (admin)

app.get('/zones', requireAdmin, async (req, res) => {
  const { rows: zones } = await query('SELECT * FROM zones ORDER BY number');
  const rows = zones.map((z) => `
    <tr>
      <td data-label="Station">#${z.number}<input type="hidden" name="id[]" value="${z.id}"></td>
      <td data-label="Name"><input type="text" name="name[]" value="${e(z.name)}"></td>
      <td data-label="Relay ID"><input type="text" name="relay[]" value="${e(z.hydrawise_relay_id || '')}" placeholder="(optional)"></td>
      <td data-label="Enabled"><input type="checkbox" name="enabled[]" value="${z.id}" ${z.enabled ? 'checked' : ''}></td>
    </tr>`).join('');

  let html = await header(req, { title: 'Zones', activeNav: 'zones' });
  html += `
<div class="page-title"><div><h1>Zones</h1><p>Match each Hunter station number to what it actually waters. "Relay ID" is only needed once you're on the live Hydrawise API — leave it blank for now.</p></div></div>
<div class="card">
  <form method="post" action="/zones">
    ${csrfField(req)}
    <table class="responsive"><thead><tr><th style="width:4rem">Station</th><th>Name</th><th style="width:10rem">Hydrawise Relay ID</th><th style="width:5rem">Enabled</th></tr></thead><tbody>${rows}</tbody></table>
    <div style="margin-top:1rem"><button type="submit">Save Zones</button></div>
  </form>
</div>` + footer();
  res.send(html);
});

app.post('/zones', requireAdmin, requireCsrf, async (req, res) => {
  let ids = req.body.id || [];
  let names = req.body.name || [];
  let relays = req.body.relay || [];
  let enabled = req.body.enabled || [];
  if (!Array.isArray(ids)) ids = [ids];
  if (!Array.isArray(names)) names = [names];
  if (!Array.isArray(relays)) relays = [relays];
  if (!Array.isArray(enabled)) enabled = [enabled];

  for (let i = 0; i < ids.length; i++) {
    const id = parseInt(ids[i], 10);
    const name = (names[i] || '').trim() || `Zone ${id}`;
    const relay = (relays[i] || '').trim();
    const isEnabled = enabled.includes(String(id));
    await query('UPDATE zones SET name=$1, hydrawise_relay_id=$2, enabled=$3 WHERE id=$4', [name, relay || null, isEnabled, id]);
  }
  flash(req, 'success', 'Zones updated.');
  res.redirect('/zones');
});

// ---------------------------------------------------------------- users (admin)

app.get('/users', requireAdmin, async (req, res) => {
  const { rows: users } = await query('SELECT * FROM users ORDER BY role, username');
  const rows = users.map((row) => `
    <tr>
      <td data-label="Name">${e(row.full_name)}${row.must_change_password ? ' <span class="muted" style="font-size:0.78rem">(must set password)</span>' : ''}</td>
      <td data-label="Username">${e(row.username)}</td>
      <td data-label="Role"><span class="badge-role">${e(row.role)}</span></td>
      <td class="right">
        <form method="post" action="/users" style="display:inline">
          ${csrfField(req)}<input type="hidden" name="action" value="reset_password"><input type="hidden" name="id" value="${row.id}">
          <button type="submit" class="small secondary">Reset password</button>
        </form>
        <form method="post" action="/users" style="display:inline" onsubmit="return confirm('Remove this user?');">
          ${csrfField(req)}<input type="hidden" name="action" value="delete"><input type="hidden" name="id" value="${row.id}">
          <button type="submit" class="small danger">Delete</button>
        </form>
      </td>
    </tr>`).join('');

  let html = await header(req, { title: 'Users', activeNav: 'users' });
  html += `
<div class="page-title"><div><h1>Users</h1><p><strong>Admin</strong> can edit programs, zones, users, and settings. <strong>Crew</strong> can view schedules and use Manual Control only.</p></div></div>
<div class="card">
  <h2 style="margin-top:0;font-size:1rem">Add a user</h2>
  <form method="post" action="/users" style="display:flex;gap:0.6rem;flex-wrap:wrap;align-items:end">
    ${csrfField(req)}<input type="hidden" name="action" value="create">
    <div class="form-row" style="margin-bottom:0"><label>Full name</label><input type="text" name="full_name" required></div>
    <div class="form-row" style="margin-bottom:0"><label>Username</label><input type="text" name="username" required></div>
    <div class="form-row" style="margin-bottom:0"><label>Temp password</label><input type="text" name="password" required minlength="8"></div>
    <div class="form-row" style="margin-bottom:0"><label>Role</label><select name="role"><option value="crew">Crew</option><option value="admin">Admin</option></select></div>
    <button type="submit">Add User</button>
  </form>
</div>
<div class="card"><table class="responsive"><thead><tr><th>Name</th><th>Username</th><th>Role</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` + footer();
  res.send(html);
});

app.post('/users', requireAdmin, requireCsrf, async (req, res) => {
  const u = req.user;
  const action = req.body.action;

  if (action === 'create') {
    const username = (req.body.username || '').trim();
    const fullName = (req.body.full_name || '').trim();
    const role = req.body.role === 'admin' ? 'admin' : 'crew';
    const password = req.body.password || '';

    if (!username || !fullName || password.length < 8) {
      flash(req, 'error', 'Please fill in all fields; password needs 8+ characters.');
      return res.redirect('/users');
    }
    try {
      const hash = await bcrypt.hash(password, 10);
      await query(
        'INSERT INTO users (username, password_hash, full_name, role, must_change_password) VALUES ($1,$2,$3,$4,true)',
        [username, hash, fullName, role]
      );
      flash(req, 'success', `User "${username}" created. They'll be asked to set a new password on first login.`);
    } catch (err) {
      flash(req, 'error', 'That username is already taken.');
    }
    return res.redirect('/users');
  }

  if (action === 'reset_password') {
    const id = parseInt(req.body.id, 10);
    const temp = crypto.randomBytes(4).toString('hex');
    const hash = await bcrypt.hash(temp, 10);
    await query('UPDATE users SET password_hash=$1, must_change_password=true WHERE id=$2', [hash, id]);
    flash(req, 'success', `Temporary password: ${temp} — share it with them; they'll set their own on next login.`);
    return res.redirect('/users');
  }

  if (action === 'delete') {
    const id = parseInt(req.body.id, 10);
    if (id === u.id) {
      flash(req, 'error', "You can't delete your own account while logged in as it.");
    } else {
      await query('DELETE FROM users WHERE id = $1', [id]);
      flash(req, 'success', 'User removed.');
    }
    return res.redirect('/users');
  }

  res.redirect('/users');
});

// ---------------------------------------------------------------- settings (admin)

app.get('/settings', requireAdmin, async (req, res) => {
  const apiKey = await getSetting('hydrawise_api_key', '');
  const serial = await getSetting('controller_serial', '');
  const controllerId = await getSetting('hydrawise_controller_id', '');
  const mock = (await getSetting('mock_mode', '1')) === '1';

  // Auto-generate the voice-control token the first time this page is
  // viewed, so there's always a real value to show/copy without a
  // separate "generate" step.
  let voiceToken = await getSetting('voice_api_token', '');
  if (!voiceToken) {
    voiceToken = crypto.randomBytes(24).toString('hex');
    await setSetting('voice_api_token', voiceToken);
  }
  const appUrl = `${req.protocol}://${req.get('host')}`;
  const voiceRunUrl = `${appUrl}/api/voice/run?zone={zone}&minutes={minutes}&token=${voiceToken}`;

  let html = await header(req, { title: 'Settings', activeNav: 'settings' });
  html += `
<div class="page-title"><div><h1>Settings</h1><p>Connect this app to your real Hydrawise account once the controller is released by the previous owner.</p></div></div>
<div class="card" style="max-width:520px">
  <h2 style="margin-top:0;font-size:1rem">Hydrawise API connection</h2>
  <p class="muted" style="font-size:0.87rem">In Hydrawise, go to your account menu → Account Details → Account Settings → Generate API Key, then paste it below. Until a key is entered, every action in this app is simulated so your crew can use it normally.</p>
  <form method="post" action="/settings">
    ${csrfField(req)}
    <div class="form-row"><label>Hydrawise API key</label><input type="text" name="hydrawise_api_key" value="${e(apiKey)}" placeholder="paste key here once you have account access"></div>
    <div class="form-row"><label>Controller serial number (optional)</label><input type="text" name="controller_serial" value="${e(serial)}" placeholder="found on the PHC-2400 unit / Hydrawise app"></div>
    <div class="form-row">
      <label>Hydrawise Controller ID ${controllerId ? '' : '<span style="color:var(--flag)">(recommended now that your account has more than one controller)</span>'}</label>
      <input type="text" name="hydrawise_controller_id" value="${e(controllerId)}" placeholder="e.g. 123456 — see 'List Hydrawise controllers' below">
      <p class="muted" style="font-size:0.8rem;margin:0.3rem 0 0">This is Hydrawise's internal cloud ID for YOUR real "MHGC" controller — different from the serial number above. With more than one controller on the account, leaving this blank means Hydrawise decides which one to talk to on its own, which can silently pick the wrong one.</p>
    </div>
    <div class="form-row"><label><input type="checkbox" name="force_demo" style="width:auto" ${mock && apiKey ? 'checked' : ''}> Keep demo mode on even with a key saved (for testing)</label></div>
    <button type="submit">Save</button>
  </form>
  <p style="margin-top:1rem">Current mode: <strong>${mock ? 'Demo (simulated)' : 'Live (real controller)'}</strong></p>
  ${apiKey ? `<p style="margin-top:0.5rem"><a href="/settings/hydrawise-controllers">List Hydrawise controllers (find the right ID)</a></p>` : ''}
  ${apiKey ? `<p style="margin-top:0.5rem"><a href="/settings/hydrawise-debug">View raw Hydrawise status data (debug)</a></p>` : ''}
</div>

<div class="card" style="max-width:640px">
  <h2 style="margin-top:0;font-size:1rem">Voice control (Alexa / Google Assistant / Siri)</h2>
  <p class="muted" style="font-size:0.87rem">This link starts a single zone for a set number of minutes — no login needed, protected instead by the secret token built into the URL. Keep this link private; anyone who has it can start a zone. A matching Stop link is below it.</p>
  <div class="form-row">
    <label>Run URL (voice assistant fills in the zone and minutes)</label>
    <textarea readonly style="width:100%;font-family:monospace;font-size:0.78rem;padding:0.5rem" rows="2" onclick="this.select()">${e(voiceRunUrl)}</textarea>
  </div>
  <div class="form-row">
    <label>Stop URL</label>
    <textarea readonly style="width:100%;font-family:monospace;font-size:0.78rem;padding:0.5rem" rows="2" onclick="this.select()">${e(`${appUrl}/api/voice/stop?zone={zone}&token=${voiceToken}`)}</textarea>
  </div>
  <p class="muted" style="font-size:0.8rem">
    <strong>Google Assistant setup (via IFTTT, supports "water hole 1 for 12 minutes" style phrases):</strong><br>
    1. Create a free account at ifttt.com<br>
    2. New Applet → "If This" → Google Assistant → "Say a phrase with a number" → phrase template: <code>Water hole $ for $ minutes</code><br>
    3. "Then That" → Webhooks → URL: paste the Run URL above, but replace <code>{zone}</code> with <code>{{NumberField}}</code> and <code>{minutes}</code> with <code>{{NumberField2}}</code> (IFTTT's own placeholders for the two numbers) → Method: GET
  </p>
  <form method="post" action="/settings/regenerate-voice-token" onsubmit="return confirm('This immediately breaks any Alexa/Google/Siri shortcuts already set up with the old link. Continue?');" style="margin-top:1rem">
    ${csrfField(req)}
    <button type="submit" class="secondary">Regenerate token (invalidates the link above)</button>
  </form>
</div>` + footer();
  res.send(html);
});

app.post('/settings/regenerate-voice-token', requireAdmin, requireCsrf, async (req, res) => {
  await setSetting('voice_api_token', crypto.randomBytes(24).toString('hex'));
  flash(req, 'success', 'Voice control token regenerated — update any Alexa/Google/Siri shortcuts with the new link.');
  res.redirect('/settings');
});

app.get('/settings/hydrawise-controllers', requireAdmin, async (req, res) => {
  const hc = await HydrawiseClient.create();
  const result = await hc.listControllers();

  let pretty;
  if (result.error) {
    pretty = 'Error: ' + result.error;
  } else {
    try {
      pretty = JSON.stringify(JSON.parse(result.raw), null, 2);
    } catch (e) {
      pretty = 'Response was not valid JSON. Raw response below:\n\n' + result.raw;
    }
  }

  let html = await header(req, { title: 'Hydrawise Controllers', activeNav: 'settings' });
  html += `
<div class="page-title"><div><h1>Hydrawise Controllers</h1><p>Every controller on this Hydrawise account, straight from their API. Find the entry for your real "MHGC" controller (the one with 24 real zones and history — not an empty duplicate, and not the still-pending second unit), copy its <code>controller_id</code>, and paste it into the "Hydrawise Controller ID" field in Settings.</p></div></div>
<div class="card">
  <pre style="white-space:pre-wrap;word-break:break-word;font-size:0.78rem;background:#f5f5f0;padding:1rem;border-radius:6px;max-height:70vh;overflow:auto">${e(pretty)}</pre>
  <p style="margin-top:1rem"><a href="/settings">← Back to Settings</a></p>
</div>` + footer();
  res.send(html);
});

app.get('/settings/hydrawise-debug', requireAdmin, async (req, res) => {
  const hc = await HydrawiseClient.create();
  const result = await hc.rawStatusSchedule();

  let pretty;
  if (result.error) {
    pretty = 'Error: ' + result.error;
  } else {
    try {
      pretty = JSON.stringify(JSON.parse(result.raw), null, 2);
    } catch (e) {
      pretty = 'Response was not valid JSON. Raw response below:\n\n' + result.raw;
    }
  }

  let html = await header(req, { title: 'Hydrawise Debug', activeNav: 'settings' });
  html += `
<div class="page-title"><div><h1>Hydrawise Debug</h1><p>Raw response from Hydrawise's statusschedule.php, unmodified. Read-only — this doesn't change any zone or schedule. Use it to check the exact field names/values (relay_id, relay, time, running, etc.) your account actually returns.</p></div></div>
<div class="card">
  <p class="muted" style="font-size:0.85rem">Mode: ${hc.mock ? 'Demo (mock_mode is ON — the call above still hits the real API using your saved key, if any, regardless of mock mode)' : 'Live'}</p>
  <pre style="white-space:pre-wrap;word-break:break-word;font-size:0.78rem;background:#f5f5f0;padding:1rem;border-radius:6px;max-height:70vh;overflow:auto">${e(pretty)}</pre>
  <p style="margin-top:1rem"><a href="/settings">← Back to Settings</a></p>
</div>` + footer();
  res.send(html);
});

app.post('/settings', requireAdmin, requireCsrf, async (req, res) => {
  const apiKey = (req.body.hydrawise_api_key || '').trim();
  const serial = (req.body.controller_serial || '').trim();
  const controllerId = (req.body.hydrawise_controller_id || '').trim();
  const forceDemo = !!req.body.force_demo;

  await setSetting('hydrawise_api_key', apiKey);
  await setSetting('controller_serial', serial);
  await setSetting('hydrawise_controller_id', controllerId);
  await setSetting('mock_mode', apiKey && !forceDemo ? '0' : '1');

  flash(req, 'success', apiKey && !forceDemo ? 'Live mode enabled — actions now go to the real Hydrawise API.' : 'Settings saved. Still in demo mode.');
  res.redirect('/settings');
});

// ---------------------------------------------------------------- run log

app.get('/log', requireLogin, async (req, res) => {
  const { rows } = await query(`
    SELECT rl.*, z.name AS zone_name, z.number AS zone_number, p.name AS program_name
    FROM run_log rl
    LEFT JOIN zones z ON z.id = rl.zone_id
    LEFT JOIN programs p ON p.id = rl.program_id
    ORDER BY rl.ts DESC LIMIT 200
  `);

  const rowsHtml = rows.map((r) => `
    <tr>
      <td data-label="When" class="muted">${e(fmtLogTime(r.ts))}</td>
      <td data-label="Zone">${r.zone_name ? e(`Z${r.zone_number} ${r.zone_name}`) : '<span class="muted">all zones</span>'}</td>
      <td data-label="Action">${e(r.action[0].toUpperCase() + r.action.slice(1))}${r.duration_minutes ? ` (${r.duration_minutes}m)` : ''}</td>
      <td data-label="Source" class="muted">${r.program_name ? e(r.program_name) : 'Manual'}</td>
      <td data-label="Triggered by" class="muted">${e(r.triggered_by.startsWith('user:') ? r.triggered_by.split(':')[2] : r.triggered_by)}</td>
      <td data-label="Result">
        ${r.status === 'success' ? '<span class="status-pill status-running">OK</span>' : '<span class="status-pill status-suspended">Error</span>'}
        ${r.message ? `<div class="muted" style="font-size:0.76rem;max-width:220px">${e(r.message)}</div>` : ''}
      </td>
    </tr>`).join('');

  let html = await header(req, { title: 'Run Log', activeNav: 'log' });
  html += `
<div class="page-title"><div><h1>Run Log</h1><p>Last 200 actions — scheduled and manual, including who or what triggered each one.</p></div></div>
<div class="card">
  ${!rows.length ? '<p class="empty-state">No activity yet.</p>' :
    `<table class="responsive"><thead><tr><th>When</th><th>Zone</th><th>Action</th><th>Source</th><th>Triggered by</th><th>Result</th></tr></thead><tbody>${rowsHtml}</tbody></table>`}
</div>` + footer();
  res.send(html);
});

// ---------------------------------------------------------------- health check (for Render)

app.get('/healthz', (req, res) => res.send('ok'));

// ---------------------------------------------------------------- voice control (Alexa/Google Assistant/Siri)
//
// Authenticated by a long secret token instead of a login session, since
// a voice assistant calling a webhook has no way to log in. The token is
// generated once and stored as a setting; see /settings for the value
// and setup instructions. Uses a timing-safe comparison so the token
// can't be guessed faster by an attacker measuring response times.
function timingSafeTokenMatch(expected, given) {
  if (!expected || !given) return false;
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(given));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

app.get('/api/voice/run', async (req, res) => {
  const token = await getSetting('voice_api_token', '');
  if (!timingSafeTokenMatch(token, req.query.token)) {
    return res.status(403).json({ ok: false, message: 'Invalid or missing token.' });
  }
  const zoneNumber = parseInt(req.query.zone, 10);
  const minutes = Math.max(1, Math.min(180, parseInt(req.query.minutes, 10) || 10));
  if (!zoneNumber) {
    return res.status(400).json({ ok: false, message: 'Missing or invalid zone number.' });
  }
  const { rows } = await query('SELECT * FROM zones WHERE number = $1', [zoneNumber]);
  const zone = rows[0];
  if (!zone) return res.status(404).json({ ok: false, message: `No zone numbered ${zoneNumber}.` });
  if (!zone.enabled) return res.status(400).json({ ok: false, message: `${zone.name} is disabled.` });

  const hc = await HydrawiseClient.create();
  const r = await hc.runZone(zone, minutes, 'voice assistant');
  res.json({ ok: r.ok, message: r.ok ? `${zone.name}: running for ${minutes} minutes.` : r.message });
});

app.get('/api/voice/stop', async (req, res) => {
  const token = await getSetting('voice_api_token', '');
  if (!timingSafeTokenMatch(token, req.query.token)) {
    return res.status(403).json({ ok: false, message: 'Invalid or missing token.' });
  }
  const zoneNumber = parseInt(req.query.zone, 10);
  if (!zoneNumber) {
    return res.status(400).json({ ok: false, message: 'Missing or invalid zone number.' });
  }
  const { rows } = await query('SELECT * FROM zones WHERE number = $1', [zoneNumber]);
  const zone = rows[0];
  if (!zone) return res.status(404).json({ ok: false, message: `No zone numbered ${zoneNumber}.` });

  const hc = await HydrawiseClient.create();
  const r = await hc.stopZone(zone, 'voice assistant');
  res.json({ ok: r.ok, message: r.ok ? `${zone.name}: stopped.` : r.message });
});

// ---------------------------------------------------------------- in-process scheduler
//
// Render web services run continuously (unlike serverless functions), so a
// simple minute-aligned interval is enough — no separate cron resource
// needed. Safe to run every minute: a program already triggered today is
// skipped so it won't double-fire even if the tick is late or overlaps.

// A fixed spacing (in ms) used only for actions with no natural "how long
// does this zone run" duration to space by (currently: bulk Stop). Chosen
// so that even the largest realistic zone count (24) firing back-to-back
// at this interval stays comfortably under Hydrawise's real limit of 10
// requests per 5-minute window.
// A fixed spacing (in ms) used only for actions with no natural "how long
// does this zone run" duration to space by (currently: bulk Stop). This
// used to be 35s, which works out to ~8.5 requests per 5 minutes from
// Stop All ALONE — leaving almost no headroom for anything else hitting
// the same real Hydrawise account limit (10 requests/5min) at the same
// time: the live-status polling this app itself does, or a manual
// Run/Resume/Stop click made while a Stop All is still draining. That
// gap is exactly what caused a real rate-limit storm — not just our own
// internal throttle, but genuine "Exceeded maximum number of requests"
// errors straight from Hydrawise. 50s leaves real margin (~6/5min from
// Stop All) for that other traffic to coexist safely.
const SEQUENTIAL_STOP_SPACING_MS = 50000; // 50s -> ~6 requests per 5 min, leaving headroom

/**
 * Fires a list of { zone, minutes } run commands ONE AT A TIME: the first
 * fires immediately, each next one only once the previous zone's `minutes`
 * have elapsed. This matters for two reasons:
 *   1. Real irrigation zones share one water supply/pressure — they're
 *      meant to run in sequence, not all open at once.
 *   2. Hydrawise's real API rate-limits to 10 requests per 5 minutes on
 *      this endpoint; firing many zones back-to-back blows through that
 *      instantly (a >10-zone program used to fail partway through every
 *      single night, silently).
 * Only the first zone fires immediately (awaited) — every zone after that
 * is QUEUED in the database with a fire_at timestamp, not scheduled with
 * setTimeout. An in-memory timer only survives as long as this exact
 * process keeps running; a Render restart mid-sequence (a redeploy, a
 * health check, anything) silently drops every timer with it and nothing
 * after that point ever fires — no error, just silence, which is exactly
 * what was happening (a 19-zone "Run All" failing partway through at a
 * different zone each time, depending on when a restart happened to land).
 * The once-a-minute scheduler tick sweeps this queue, so a queued zone
 * fires on schedule even if the process that queued it is long gone.
 *
 * IMPORTANT: only the NEXT zone is ever queued at a time (with the rest
 * carried along as `remaining_runs`). Each zone after that gets queued by
 * runDuePendingZones(), at the moment the zone before it actually fires,
 * relative to THAT real clock time — never off one fixed plan computed
 * up front. Zones used to be pre-scheduled all at once, as one fixed list
 * of absolute timestamps computed off a single Date.now() snapshot at the
 * very start. Any real-world delay along the way (the scheduler only
 * ticks about once a minute, so a zone can start a minute or two late) was
 * never absorbed — it just accumulated, zone after zone, silently. On a
 * long program that eventually adds up to more than one zone's length,
 * so a later zone's already-fixed start command fires WHILE the zone
 * before it is still actually running — and since these zones share one
 * water line, starting the next one immediately cuts the current one off
 * early. Chaining off the real fire time, one zone at a time, is what
 * keeps the whole sequence self-correcting instead of drifting.
 */
async function dispatchSequentialRuns(runs, hc, triggeredBy, programId) {
  if (!runs.length) return;
  const [first, ...rest] = runs;
  await hc.runZone(first.zone, first.minutes, triggeredBy, programId);
  await queueNextRun(rest, first.minutes, hc, triggeredBy, programId, first.zone.id);
}

/**
 * Queues the next step in a sequence to fire `afterMinutes` from RIGHT NOW
 * — i.e. from whenever the zone currently running actually began — not
 * from any earlier fixed point in time. This is the piece that makes the
 * sequence self-correcting: if an earlier zone started a little late, the
 * zone after it inherits that same real start time instead of drifting
 * further out of sync with what's actually running on the controller.
 *
 * `currentZoneId` is the zone that's running RIGHT NOW and needs to be
 * explicitly stopped at that same moment — either to make way for the
 * next zone (queued with previous_zone_id set, so runDuePendingZones
 * stops it immediately before starting the next one), or, if this is the
 * last zone in the sequence, as its own queued 'stop' so the whole
 * sequence ends precisely on our own clock rather than waiting on
 * Hydrawise's own auto-stop timer. This pairing is what keeps a Master-
 * Valve-driven pump running continuously through the whole sequence: the
 * previous zone used to be left to expire on Hydrawise's OWN internal
 * timer while the next zone's start was driven by OUR separate scheduler
 * tick (which only checks in once every ~60s) — two independent clocks
 * that don't agree, leaving a real window (up to that ~60s) where
 * Hydrawise saw zero zones active and could drop the pump relay, then
 * re-engage it for the next zone. Stopping the current zone and starting
 * the next one back-to-back, off one single clock, closes that gap to
 * essentially the time it takes to make two consecutive API calls.
 */
async function queueNextRun(remainingRuns, afterMinutes, hc, triggeredBy, programId, currentZoneId) {
  const fireAt = new Date(Date.now() + afterMinutes * 60000);
  if (!remainingRuns.length) {
    // Last zone in the sequence — queue its own explicit stop rather than
    // leaving it to Hydrawise's independent auto-stop timer, so the pump
    // drops right when our own clock says the sequence is actually done.
    if (currentZoneId) {
      await query(
        `INSERT INTO pending_zone_runs (zone_id, program_id, action, minutes, triggered_by, fire_at)
         VALUES ($1,$2,'stop',NULL,$3,$4)`,
        [currentZoneId, programId, triggeredBy, fireAt]
      );
    }
    return;
  }
  const [next, ...rest] = remainingRuns;
  const remainingForDb = rest.map((r) => ({ zone_id: r.zone.id, minutes: r.minutes }));
  await query(
    `INSERT INTO pending_zone_runs (zone_id, program_id, action, minutes, triggered_by, fire_at, remaining_runs, previous_zone_id)
     VALUES ($1,$2,'run',$3,$4,$5,$6,$7)`,
    [next.zone.id, programId, next.minutes, triggeredBy, fireAt, JSON.stringify(remainingForDb), currentZoneId || null]
  );
}

/** Same idea as dispatchSequentialRuns, but for Stop — no natural duration to space by, so a fixed safe interval is used instead. Also DB-queued for the same restart-safety reason. */
async function dispatchSequentialStops(zones, hc, triggeredBy) {
  for (let i = 0; i < zones.length; i++) {
    const z = zones[i];
    if (i === 0) {
      await hc.stopZone(z, triggeredBy);
    } else {
      const fireAt = new Date(Date.now() + i * SEQUENTIAL_STOP_SPACING_MS);
      await query(
        `INSERT INTO pending_zone_runs (zone_id, program_id, action, minutes, triggered_by, fire_at)
         VALUES ($1,NULL,'stop',NULL,$2,$3)`,
        [z.id, triggeredBy, fireAt]
      );
    }
  }
}

/** Fires any queued zone whose scheduled time has arrived. Called every scheduler tick (every ~60s), so a queued zone fires within about a minute of its fire_at even across a server restart. */
async function runDuePendingZones(hc) {
  const { rows: due } = await query(
    `DELETE FROM pending_zone_runs WHERE fire_at <= now() RETURNING *`
  );
  for (const row of due) {
    try {
      const { rows: zoneRows } = await query('SELECT * FROM zones WHERE id = $1', [row.zone_id]);
      const zone = zoneRows[0];
      if (!zone) {
        console.error(`[pending run] zone ${row.zone_id} no longer exists, skipping`);
        continue;
      }
      if (row.action === 'run') {
        // Stop the PREVIOUS zone immediately before starting this one —
        // both off this same tick, back-to-back — rather than leaving the
        // previous zone to expire on Hydrawise's own independent timer.
        // See the comment on queueNextRun() above for why this pairing is
        // what keeps a Master-Valve-driven pump running continuously
        // through the sequence instead of dropping and re-engaging
        // between every zone.
        if (row.previous_zone_id) {
          const { rows: prevRows } = await query('SELECT * FROM zones WHERE id = $1', [row.previous_zone_id]);
          if (prevRows[0]) await hc.stopZone(prevRows[0], row.triggered_by);
        }
        const result = await hc.runZone(zone, row.minutes, row.triggered_by, row.program_id);
        // A rate-limit failure is TRANSIENT — the zone never got its
        // command, so retry the SAME zone shortly rather than treating it
        // as done and moving on (which is what silently dropped zones
        // during tonight's rate-limit storm: a failed Run was logged as
        // an error and the chain just carried on to the next zone as if
        // it had watered). Anything else (a genuinely invalid operation,
        // a missing zone) isn't worth retrying — log and continue.
        //
        // IMPORTANT: an "internal throttle" failure gets a much longer
        // retry delay than a real external Hydrawise rate-limit error.
        // Both used to retry after the same 90s — but every retry
        // attempt, even a failed one, still counts toward OUR OWN 5-
        // minute throttle window. Retrying our own throttle after only
        // 90s meant each attempt just added another counted entry that
        // kept the SAME throttle tripped, forever — a self-sustaining
        // loop that could never clear on its own no matter how long
        // someone waited, since the retries themselves were the thing
        // keeping it stuck. A real external Hydrawise error has no such
        // feedback loop, so 90s is still fine there.
        const isInternalThrottle = /internal throttle/i.test(result.message || '');
        const isExternalRateLimit = !isInternalThrottle && /exceeded maximum/i.test(result.message || '');
        if (!result.ok && (isInternalThrottle || isExternalRateLimit)) {
          const retryDelayMs = isInternalThrottle ? 300000 : 90000;
          console.log(`[pending run] zone ${zone.id} hit ${isInternalThrottle ? 'our own' : 'Hydrawise\'s'} rate limit — retrying in ${retryDelayMs / 1000}s instead of skipping ahead.`);
          await query(
            `INSERT INTO pending_zone_runs (zone_id, program_id, action, minutes, triggered_by, fire_at, remaining_runs, previous_zone_id)
             VALUES ($1,$2,'run',$3,$4,$5,$6,$7)`,
            [zone.id, row.program_id, row.minutes, row.triggered_by, new Date(Date.now() + retryDelayMs), JSON.stringify(row.remaining_runs || []), row.previous_zone_id]
          );
          continue; // don't advance the chain — this zone hasn't actually run yet
        }
        // Chain the NEXT step off this zone's actual fire time (right
        // now), not off any earlier fixed schedule — see the comment on
        // queueNextRun() above for why that matters.
        const remaining = row.remaining_runs || [];
        const zoneIds = remaining.map((r) => r.zone_id);
        const { rows: zoneObjs } = zoneIds.length ? await query('SELECT * FROM zones WHERE id = ANY($1)', [zoneIds]) : { rows: [] };
        const byId = new Map(zoneObjs.map((z) => [z.id, z]));
        const restRuns = remaining
          .map((r) => ({ zone: byId.get(r.zone_id), minutes: r.minutes }))
          .filter((r) => r.zone); // drop any zone removed since this was queued
        await queueNextRun(restRuns, row.minutes, hc, row.triggered_by, row.program_id, zone.id);
      } else {
        // Same rate-limit-retry logic as the 'run' branch above — this
        // was MISSING here, which is exactly what silently dropped
        // several zones' stop commands during tonight's rate-limit
        // storm: a throttled stop just logged an error and was gone for
        // good, with nothing to ever try it again. A zone whose stop
        // never lands stays physically running indefinitely.
        const result = await hc.stopZone(zone, row.triggered_by);
        const isInternalThrottle = /internal throttle/i.test(result.message || '');
        const isExternalRateLimit = !isInternalThrottle && /exceeded maximum/i.test(result.message || '');
        if (!result.ok && (isInternalThrottle || isExternalRateLimit)) {
          const retryDelayMs = isInternalThrottle ? 300000 : 90000;
          console.log(`[pending run] stop for zone ${zone.id} hit ${isInternalThrottle ? 'our own' : 'Hydrawise\'s'} rate limit — retrying in ${retryDelayMs / 1000}s instead of dropping it.`);
          await query(
            `INSERT INTO pending_zone_runs (zone_id, program_id, action, minutes, triggered_by, fire_at)
             VALUES ($1,$2,'stop',NULL,$3,$4)`,
            [zone.id, row.program_id, row.triggered_by, new Date(Date.now() + retryDelayMs)]
          );
        }
      }
    } catch (err) {
      console.error(`[pending run] failed for zone ${row.zone_id} (action=${row.action}):`, err);
    }
  }
  if (due.length) console.log(`[pending run] fired ${due.length} queued zone command(s)`);
}

/** True if some zone is still within its watering window right now — i.e.
 * the most recent 'run' log entry hasn't finished yet (its start time +
 * duration is still in the future). This is the guard that was missing:
 * nothing previously stopped a second sequence (a manual Run Now/Run All,
 * or the scheduler) from starting while an earlier one was still
 * mid-flight. Two independent chains both targeting the same single-
 * zone-at-a-time controller then fight each other — each new command
 * preempts whatever the other chain currently has running, which looks
 * like zones firing "out of order" and getting cut short partway through
 * (e.g. a scheduled run and a manual Run Now on the same program
 * overlapping). Checking the actual run_log rather than pending_zone_runs
 * matters because pending_zone_runs is briefly EMPTY during a chain's
 * very last zone (there's nothing left to queue), which would otherwise
 * make the system look "free" right when it's most definitely not.
 */
/** True if there are still queued 'stop' commands waiting to fire — used to
 * block Stop All from being clicked again while an earlier stop-sequence
 * is still working through its zones (see the comment where this is
 * called for the incident this prevents). */
async function hasPendingStops() {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS c FROM pending_zone_runs WHERE action = 'stop'`
  );
  return rows[0].c > 0;
}

/**
 * True if some zone is still within its watering window right now — i.e.
 * the most recent SUCCESSFUL 'run' log entry hasn't finished yet (its
 * start time + duration is still in the future). Only successful runs
 * count — a FAILED attempt (e.g. "Controller not found") never actually
 * started a zone, so it must not block a fresh attempt from starting.
 * Counting failed attempts here was a real bug: three failed Run Now
 * clicks in a row (from a bad Controller ID) each still logged with
 * their intended duration, so the next 3-9 minutes looked "busy" even
 * though nothing was actually running.
 */
async function isSequenceBusy() {
  const { rows } = await query(
    `SELECT ts, duration_minutes FROM run_log
     WHERE action = 'run' AND zone_id IS NOT NULL AND duration_minutes IS NOT NULL AND status = 'success'
     ORDER BY ts DESC LIMIT 1`
  );
  if (!rows.length) return false;
  const finishesAt = new Date(rows[0].ts).getTime() + rows[0].duration_minutes * 60000;
  return finishesAt > Date.now();
}

/** Starts every zone in a program (used by the scheduler and by "Run Now"). */
async function runProgramZones(program, hc, triggeredBy) {
  const { rows: zoneRows } = await query(
    `SELECT z.*, pz.duration_minutes FROM program_zones pz JOIN zones z ON z.id = pz.zone_id
     WHERE pz.program_id = $1 AND z.enabled = true ORDER BY pz.sort_order`,
    [program.id]
  );
  const runs = zoneRows.map((z) => ({
    zone: z,
    minutes: Math.max(1, Math.round(z.duration_minutes * (program.seasonal_adjust_pct / 100))),
  }));
  await dispatchSequentialRuns(runs, hc, triggeredBy, program.id);
  return runs.length;
}

// ---------------------------------------------------------------- hot list
//
// A "Hot List" is a live, add-as-you-go queue for walking the course and
// spot-watering whatever green needs it right now — start one, then add
// another from wherever you are on the course a few minutes later, and it
// just joins the line. Reuses the exact same pending_zone_runs chain the
// scheduler and Run All already use, so the pump/Master Valve stays
// engaged continuously across every addition, the same way it does across
// a normal multi-zone program.

/** The zone_id currently inside its active watering window right now (the
 * most recent successful 'run' log entry that hasn't finished yet), or
 * null if nothing is running. Same success-only logic as isSequenceBusy()
 * above, just returning which zone instead of a plain boolean — the Hot
 * List needs to know WHICH zone to chain the next addition off of. */
async function currentlyRunningZoneId() {
  const { rows } = await query(
    `SELECT zone_id, ts, duration_minutes FROM run_log
     WHERE action = 'run' AND zone_id IS NOT NULL AND duration_minutes IS NOT NULL AND status = 'success'
     ORDER BY ts DESC LIMIT 1`
  );
  if (!rows.length) return null;
  const finishesAt = new Date(rows[0].ts).getTime() + rows[0].duration_minutes * 60000;
  return finishesAt > Date.now() ? rows[0].zone_id : null;
}

/**
 * Adds one zone to whatever's already running, without ever stopping the
 * pump between zones — the whole point of the Hot List. Three cases:
 *
 *  1. Nothing running at all right now: just start it, same as a normal
 *     single-zone Run.
 *  2. Something's running AND a 'run' row is already queued behind it
 *     (two or more zones still ahead in line): append to that row's
 *     remaining_runs — same JSON queue dispatchSequentialRuns/queueNextRun
 *     already use for programs, so this new zone just joins the tail of
 *     the same chain.
 *  3. Something's running and it's the LAST zone in its sequence — only
 *     its own closing 'stop' is queued (see queueNextRun's empty-
 *     remainingRuns branch), no 'run' behind it. Swap that queued stop for
 *     a queued 'run' of the new zone instead, at the exact same fire_at
 *     and with the same previous_zone_id pairing the stop would have used
 *     — so the currently-running zone still ends at precisely the right
 *     moment, but the pump goes straight into the new zone instead of
 *     dropping to idle and re-engaging.
 */
async function addToHotList(zone, minutes, triggeredBy) {
  const hc = await HydrawiseClient.create();
  const runningZoneId = await currentlyRunningZoneId();

  if (!runningZoneId) {
    await dispatchSequentialRuns([{ zone, minutes }], hc, triggeredBy, null);
    return { ok: true, message: `${zone.name}: started now.` };
  }

  const { rows: runRows } = await query(
    `SELECT * FROM pending_zone_runs WHERE action = 'run' ORDER BY fire_at ASC LIMIT 1`
  );
  if (runRows.length) {
    const row = runRows[0];
    const remaining = row.remaining_runs || [];
    remaining.push({ zone_id: zone.id, minutes });
    await query('UPDATE pending_zone_runs SET remaining_runs = $1 WHERE id = $2', [JSON.stringify(remaining), row.id]);
    return { ok: true, message: `${zone.name}: added to the queue.` };
  }

  const { rows: stopRows } = await query(
    `SELECT * FROM pending_zone_runs WHERE action = 'stop' AND zone_id = $1 ORDER BY fire_at ASC LIMIT 1`,
    [runningZoneId]
  );
  if (stopRows.length) {
    const stopRow = stopRows[0];
    await query('DELETE FROM pending_zone_runs WHERE id = $1', [stopRow.id]);
    await query(
      `INSERT INTO pending_zone_runs (zone_id, program_id, action, minutes, triggered_by, fire_at, remaining_runs, previous_zone_id)
       VALUES ($1,NULL,'run',$2,$3,$4,$5,$6)`,
      [zone.id, minutes, triggeredBy, stopRow.fire_at, JSON.stringify([]), runningZoneId]
    );
    return { ok: true, message: `${zone.name}: will start the moment the current zone finishes.` };
  }

  // Shouldn't normally happen — a running zone should always have either a
  // queued next run or a queued closing stop. Fall back to computing the
  // current zone's real finish time directly from run_log.
  const { rows: curRows } = await query(
    `SELECT ts, duration_minutes FROM run_log WHERE zone_id = $1 AND action = 'run' AND status = 'success' ORDER BY ts DESC LIMIT 1`,
    [runningZoneId]
  );
  const fireAt = curRows.length
    ? new Date(new Date(curRows[0].ts).getTime() + curRows[0].duration_minutes * 60000)
    : new Date(Date.now() + 60000);
  await query(
    `INSERT INTO pending_zone_runs (zone_id, program_id, action, minutes, triggered_by, fire_at, remaining_runs, previous_zone_id)
     VALUES ($1,NULL,'run',$2,$3,$4,$5,$6)`,
    [zone.id, minutes, triggeredBy, fireAt, JSON.stringify([]), runningZoneId]
  );
  return { ok: true, message: `${zone.name}: queued.` };
}

/** Builds the ordered list the Hot List page displays: whatever's running
 * right now (with its real time remaining), then whatever's queued behind
 * it in order. Read-only — safe to call as often as the page wants to
 * poll. */
async function hotListQueueView() {
  const items = [];
  const runningZoneId = await currentlyRunningZoneId();

  if (runningZoneId) {
    const zone = await zoneById(runningZoneId);
    const { rows } = await query(
      `SELECT ts, duration_minutes FROM run_log WHERE zone_id = $1 AND action = 'run' AND status = 'success' ORDER BY ts DESC LIMIT 1`,
      [runningZoneId]
    );
    if (zone && rows.length) {
      const endsAt = new Date(rows[0].ts).getTime() + rows[0].duration_minutes * 60000;
      items.push({ zone, minutes: rows[0].duration_minutes, status: 'running', endsAt });
    }
  }

  const { rows: runRows } = await query(
    `SELECT * FROM pending_zone_runs WHERE action = 'run' ORDER BY fire_at ASC LIMIT 1`
  );
  if (runRows.length) {
    const row = runRows[0];
    const nextZone = await zoneById(row.zone_id);
    if (nextZone) {
      // If this zone's most recent attempt failed on OUR OWN internal
      // throttle recently, it's not really just "queued" — it's actively
      // being held back and will retry at fire_at. Surfacing that
      // distinction is the whole point: before this, a throttled zone
      // just silently vanished from the visible queue for up to 5
      // minutes with no indication anything was still going to happen,
      // which is exactly what made a working retry look like a dropped
      // command. See addToHotList()/runDuePendingZones() for the retry
      // itself — this only reads the resulting state to display it.
      const { rows: throttleRows } = await query(
        `SELECT 1 FROM run_log WHERE zone_id = $1 AND status = 'error' AND message ILIKE '%internal throttle%' AND ts > now() - interval '10 minutes' ORDER BY ts DESC LIMIT 1`,
        [row.zone_id]
      );
      const retrying = throttleRows.length > 0;
      items.push({
        zone: nextZone, minutes: row.minutes,
        status: retrying ? 'retrying' : 'queued',
        endsAt: null, retryAt: retrying ? new Date(row.fire_at).getTime() : null,
      });
    }
    for (const r of (row.remaining_runs || [])) {
      const z = await zoneById(r.zone_id);
      if (z) items.push({ zone: z, minutes: r.minutes, status: 'queued', endsAt: null, retryAt: null });
    }
  }
  return items;
}


/** Fires any due zone-to-zone handoffs. Checked far more often than the
 * program schedule below (5s vs 60s) because timing here actually
 * matters for keeping the pump engaged: Hydrawise auto-stops each zone
 * on ITS OWN internal timer the instant that zone's `custom` duration
 * elapses, independent of anything our own scheduler does. The
 * stop-current/start-next pairing in runDuePendingZones() only closes
 * the gap between zones if it actually runs close to the moment the
 * current zone's duration ends — when this was combined with the
 * once-a-minute program-schedule check below, a handoff could sit
 * queued for up to ~59 seconds after Hydrawise had already dropped the
 * previous zone, which is exactly the multi-zone gap this pairing
 * exists to prevent (confirmed live: hole 9 → hole 18 → putting green
 * each had a real ~1 minute pump-off gap between them, matching this
 * tick's old 60s granularity almost exactly).
 */
async function pendingZonesTick() {
  try {
    const hc = await HydrawiseClient.create();
    await runDuePendingZones(hc);
  } catch (err) {
    console.error('[pending zones] tick failed:', err);
  }
}

/** Checks scheduled programs' start times against the clock. Program
 * start times only ever have "HH:mm" resolution, so once a minute is as
 * often as this ever needs to run — unlike pendingZonesTick() above,
 * there's no benefit to checking this one more frequently. */
async function scheduledProgramsTick() {
  try {
    const now = DateTime.now().setZone(TZ);
    const nowHM = now.toFormat('HH:mm');
    const todayDow = now.weekday % 7; // Sun=0..Sat=6
    const todayDate = now.toFormat('yyyy-MM-dd');

    const hc = await HydrawiseClient.create();

    // Only 'scheduled' programs are eligible to auto-fire — on_demand programs
    // are stored with days_mask=0 anyway, but this keeps the intent explicit.
    const { rows: programs } = await query(
      `SELECT * FROM programs WHERE enabled = true AND program_type = 'scheduled'`
    );

    for (const p of programs) {
      if (!(p.days_mask & (1 << todayDow))) continue;
      // Was time to start >= now, not "is it exactly this minute" — a
      // restart that makes the process miss the exact trigger minute
      // (the same issue the pending-zone queue above exists to guard
      // against) would otherwise mean the program silently never fires
      // for the entire day. Firing a few minutes late is far better
      // than not firing at all.
      if (nowHM < p.start_time) continue;

      const { rows: already } = await query(
        `SELECT COUNT(*)::int AS c FROM run_log WHERE program_id = $1 AND action = 'run' AND ts::date = $2::date`,
        [p.id, todayDate]
      );
      if (already[0].c > 0) continue;

      // Don't start this program's sequence on top of one that's still
      // running (e.g. someone hit Run Now on it manually a few minutes
      // before its scheduled time) — skip this tick and try again next
      // minute rather than colliding with it.
      if (await isSequenceBusy()) {
        console.log(`[scheduler] Delaying "${p.name}" — another sequence is still running.`);
        continue;
      }

      const count = await runProgramZones(p, hc, 'scheduler');
      console.log(`[scheduler] Ran program "${p.name}" (${count} zones)`);
    }
  } catch (err) {
    console.error('[scheduler] tick failed:', err);
  }
}

function startScheduler() {
  // Zone-to-zone handoffs: check every 5s so a stop-then-run pairing
  // fires close to the moment it's actually due, instead of waiting up
  // to a full minute — see pendingZonesTick() above for why this had to
  // be split out from the program-schedule check.
  pendingZonesTick();
  setInterval(pendingZonesTick, 5000);

  // Program start times: HH:mm resolution, so once a minute is enough.
  // Align the first tick to the top of the next minute, then run every 60s.
  const msToNextMinute = 60000 - (Date.now() % 60000);
  setTimeout(() => {
    scheduledProgramsTick();
    setInterval(scheduledProgramsTick, 60000);
  }, msToNextMinute);
}

// ---------------------------------------------------------------- boot

// ---------------------------------------------------------------- crash safety net
//
// Tonight, deleting a program that had run history attached threw a raw
// database error inside an async route handler with no try/catch. In
// Express 4, an error thrown inside an async handler becomes an
// unhandled promise rejection -- and on the Node version this runs on,
// an unhandled rejection TERMINATES THE WHOLE PROCESS by default. Render
// then shows a 502 until it notices the process died and restarts it a
// few seconds later, at which point everything "looks normal again" --
// but whatever action was in flight never actually completed, and the
// same bug is free to crash the app again the next time it's triggered
// (from this or any other route). Fixing the specific program-delete
// case (see schema.sql) removes today's trigger. This net catches the
// general class of bug: attaching these handlers stops Node's default
// crash-the-process behavior for an error we didn't anticipate,
// wherever it happens -- a request, the background scheduler tick,
// anything -- so one bad edge case can no longer take the whole app
// down. The specific request that hit the error will still just not
// finish cleanly, but the app itself, the scheduler, and every other
// user's session keep running.
process.on('unhandledRejection', (err) => {
  console.error('[unhandled rejection]', err);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaught exception]', err);
});

const PORT = process.env.PORT || 3000;

ensureSeeded()
  .then(() => {
    startScheduler();
    app.listen(PORT, () => console.log(`Irrigation scheduler listening on :${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
