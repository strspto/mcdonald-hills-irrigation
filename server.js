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
  TZ, DAY_LABELS, e, csrfField, requireCsrf,
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
      // Zones water ONE AT A TIME, in sequence — see the comment on
      // runProgramZones() below for why (shared water pressure, and
      // Hydrawise's real rate limit). "Run All" starts zone 1 now,
      // zone 2 once zone 1's `minutes` have elapsed, and so on.
      dispatchSequentialRuns(zones.map((z) => ({ zone: z, minutes })), hc, actor, null);
    } else {
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

// ---------------------------------------------------------------- programs

app.get('/programs', requireLogin, async (req, res) => {
  res.send(await programsPage(req));
});

app.post('/programs', requireAdmin, requireCsrf, async (req, res) => {
  const u = req.user;
  const action = req.body.action;

  if (action === 'delete') {
    await query('DELETE FROM programs WHERE id = $1', [parseInt(req.body.id, 10)]);
    flash(req, 'success', 'Program deleted.');
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
  const mock = (await getSetting('mock_mode', '1')) === '1';

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
    <div class="form-row"><label><input type="checkbox" name="force_demo" style="width:auto" ${mock && apiKey ? 'checked' : ''}> Keep demo mode on even with a key saved (for testing)</label></div>
    <button type="submit">Save</button>
  </form>
  <p style="margin-top:1rem">Current mode: <strong>${mock ? 'Demo (simulated)' : 'Live (real controller)'}</strong></p>
  ${apiKey ? `<p style="margin-top:0.5rem"><a href="/settings/hydrawise-debug">View raw Hydrawise status data (debug)</a></p>` : ''}
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
  const forceDemo = !!req.body.force_demo;

  await setSetting('hydrawise_api_key', apiKey);
  await setSetting('controller_serial', serial);
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
const SEQUENTIAL_STOP_SPACING_MS = 35000; // 35s -> ~8.5 requests per 5 min

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
  await queueNextRun(rest, first.minutes, hc, triggeredBy, programId);
}

/**
 * Queues the next run in a sequence to fire `afterMinutes` from RIGHT NOW
 * — i.e. from whenever the zone currently starting actually began — not
 * from any earlier fixed point in time. This is the piece that makes the
 * sequence self-correcting: if an earlier zone started a little late, the
 * zone after it inherits that same real start time instead of drifting
 * further out of sync with what's actually running on the controller.
 */
async function queueNextRun(remainingRuns, afterMinutes, hc, triggeredBy, programId) {
  if (!remainingRuns.length) return;
  const [next, ...rest] = remainingRuns;
  const fireAt = new Date(Date.now() + afterMinutes * 60000);
  const remainingForDb = rest.map((r) => ({ zone_id: r.zone.id, minutes: r.minutes }));
  await query(
    `INSERT INTO pending_zone_runs (zone_id, program_id, action, minutes, triggered_by, fire_at, remaining_runs)
     VALUES ($1,$2,'run',$3,$4,$5,$6)`,
    [next.zone.id, programId, next.minutes, triggeredBy, fireAt, JSON.stringify(remainingForDb)]
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
        await hc.runZone(zone, row.minutes, row.triggered_by, row.program_id);
        // Chain the NEXT zone off this zone's actual fire time (right
        // now), not off any earlier fixed schedule — see the comment on
        // queueNextRun() above for why that matters.
        const remaining = row.remaining_runs || [];
        if (remaining.length) {
          const zoneIds = remaining.map((r) => r.zone_id);
          const { rows: zoneObjs } = await query('SELECT * FROM zones WHERE id = ANY($1)', [zoneIds]);
          const byId = new Map(zoneObjs.map((z) => [z.id, z]));
          const restRuns = remaining
            .map((r) => ({ zone: byId.get(r.zone_id), minutes: r.minutes }))
            .filter((r) => r.zone); // drop any zone removed since this was queued
          await queueNextRun(restRuns, row.minutes, hc, row.triggered_by, row.program_id);
        }
      } else {
        await hc.stopZone(zone, row.triggered_by);
      }
    } catch (err) {
      console.error(`[pending run] failed for zone ${row.zone_id} (action=${row.action}):`, err);
    }
  }
  if (due.length) console.log(`[pending run] fired ${due.length} queued zone command(s)`);
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

async function schedulerTick() {
  try {
    const now = DateTime.now().setZone(TZ);
    const nowHM = now.toFormat('HH:mm');
    const todayDow = now.weekday % 7; // Sun=0..Sat=6
    const todayDate = now.toFormat('yyyy-MM-dd');

    const hc = await HydrawiseClient.create();

    // Fire anything queued from an earlier sequential run/stop whose time
    // has now arrived — this runs every tick regardless of whether a
    // scheduled program is also firing right now.
    await runDuePendingZones(hc);

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

      const count = await runProgramZones(p, hc, 'scheduler');
      console.log(`[scheduler] Ran program "${p.name}" (${count} zones)`);
    }
  } catch (err) {
    console.error('[scheduler] tick failed:', err);
  }
}

function startScheduler() {
  // Align the first tick to the top of the next minute, then run every 60s.
  const msToNextMinute = 60000 - (Date.now() % 60000);
  setTimeout(() => {
    schedulerTick();
    setInterval(schedulerTick, 60000);
  }, msToNextMinute);
}

// ---------------------------------------------------------------- boot

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
