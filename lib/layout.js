const { e, csrfField } = require('./helpers');
const { getSetting } = require('./settings');
const { currentUser } = require('./auth');

const APP_NAME = 'McDonald Hills GC Irrigation Scheduler';

function popFlashes(req) {
  const f = req.session.flash || [];
  req.session.flash = [];
  return f;
}
function flash(req, type, message) {
  if (!req.session.flash) req.session.flash = [];
  req.session.flash.push({ type, message });
}

async function header(req, { title, activeNav = '' } = {}) {
  const u = currentUser(req);
  const mock = (await getSetting('mock_mode', '1')) === '1';

  const nav = !u ? '' : `
  <nav class="nav">
    <a href="/dashboard" class="${activeNav === 'dashboard' ? 'active' : ''}">Dashboard</a>
    <a href="/programs" class="${activeNav === 'programs' ? 'active' : ''}">Programs</a>
    <a href="/manual" class="${activeNav === 'manual' ? 'active' : ''}">Manual Control</a>
    <a href="/log" class="${activeNav === 'log' ? 'active' : ''}">Run Log</a>
    ${u.role === 'admin' ? `
    <a href="/zones" class="${activeNav === 'zones' ? 'active' : ''}">Zones</a>
    <a href="/users" class="${activeNav === 'users' ? 'active' : ''}">Users</a>
    <a href="/settings" class="${activeNav === 'settings' ? 'active' : ''}">Settings</a>` : ''}
  </nav>
  <div class="user-chip">
    <span>${e(u.full_name)}</span>
    <span class="badge-role">${e(u.role)}</span>
    <form method="post" action="/logout">${csrfField(req)}<button type="submit">Log out</button></form>
  </div>`;

  const flashes = popFlashes(req).map(
    (f) => `<div class="flash flash-${e(f.type)}">${e(f.message)}</div>`
  ).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title || APP_NAME)} · ${e(APP_NAME)}</title>
<link rel="stylesheet" href="/style.css">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#1f5c37">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Irrigation">
</head>
<body>
<div class="topbar">
  <div class="brand">McDonald Hills GC <small>Irrigation Scheduler — Hunter PHC-2400</small></div>
  ${nav}
</div>
${u && mock ? `<div class="mock-banner">Demo mode: this controller isn't connected to your Hydrawise account yet, so actions here are simulated (not sent to real sprinklers). An admin can turn on live control from <a href="/settings">Settings</a> once the previous owner releases the controller.</div>` : ''}
<div class="container">
${flashes}`;
}

function footer() {
  return `</div>
</body>
</html>`;
}

module.exports = { header, footer, flash, popFlashes, APP_NAME };
