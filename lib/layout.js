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
  </nav>`;

  const userChip = !u ? '' : `
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
<div class="topbar">
  <div class="brand-row">
    <div class="brand">McDonald Hills GC <small>Irrigation Scheduler — Hunter PHC-2400</small></div>
    ${userChip}
  </div>
  ${nav}
</div>
${u && mock ? `<div class="mock-banner">Demo mode: this controller isn't connected to your Hydrawise account yet, so actions here are simulated (not sent to real sprinklers). An admin can turn on live control from <a href="/settings">Settings</a> once the previous owner releases the controller.</div>` : ''}
<div class="container">
${flashes}`;
}

function footer() {
  return `<script>
(function() {
  function fmt(ms) {
    if (ms <= 0) return 'finishing\u2026';
    var totalSec = Math.floor(ms / 1000);
    var m = Math.floor(totalSec / 60);
    var s = totalSec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s + ' left';
  }
  function tick() {
    document.querySelectorAll('.countdown[data-ends-at]').forEach(function(el) {
      var raw = el.getAttribute('data-ends-at');
      if (!raw) return; // idle/suspended zones show their detail text directly, not a countdown
      var endsAt = parseInt(raw, 10);
      if (!endsAt) return;
      el.textContent = fmt(endsAt - Date.now());
    });
  }
  tick();
  setInterval(tick, 1000);

  // Belt-and-suspenders against double-submits (the trigger behind
  // tonight's rate-limit storm: several Stop All clicks in quick
  // succession, each one queuing its own full batch of commands before
  // the page even had a chance to reload and show the result of the
  // first click). Disabling a form's submit button the instant it's
  // clicked means a second tap can't fire a second request while the
  // first one is still in flight — the server-side guards remain the
  // real protection, this just stops the easy accidental case.
  document.querySelectorAll('form').forEach(function(form) {
    form.addEventListener('submit', function() {
      var btns = form.querySelectorAll('button[type=submit], button:not([type])');
      btns.forEach(function(b) { b.disabled = true; });
    });
  });

  // Live zone status: polls /api/zone-status and updates each zone card
  // in place, so the page reflects what's actually running without
  // needing a manual pull-to-refresh or full reload. Only runs on pages
  // that actually have zone cards \u2014 harmless no-op everywhere else.
  var cards = document.querySelectorAll('.zone-card[data-zone-id]');
  if (cards.length) {
    var byId = {};
    cards.forEach(function(card) { byId[card.getAttribute('data-zone-id')] = card; });

    function applyStatus(z) {
      var card = byId[String(z.id)];
      if (!card) return;
      var pill = card.querySelector('.js-status-pill');
      var detail = card.querySelector('.js-status-detail');
      if (pill) {
        pill.className = 'status-pill status-' + z.state + ' js-status-pill';
        pill.textContent = z.state.charAt(0).toUpperCase() + z.state.slice(1);
      }
      if (detail) {
        if (z.state === 'running' && z.endsAt) {
          detail.setAttribute('data-ends-at', z.endsAt);
          detail.textContent = fmt(z.endsAt - Date.now());
        } else {
          detail.setAttribute('data-ends-at', '');
          detail.textContent = z.detail || '';
        }
      }
    }

    function poll() {
      fetch('/api/zone-status', { headers: { 'Accept': 'application/json' } })
        .then(function(r) { return r.ok ? r.json() : null; })
        .then(function(data) {
          if (data && data.zones) data.zones.forEach(applyStatus);
        })
        .catch(function() { /* network hiccup \u2014 next poll will retry */ });
    }
    poll();
    setInterval(poll, 12000);

    // Also refresh the instant the tab/app comes back to the foreground,
    // so switching back from another app shows current state immediately
    // instead of waiting up to 12s.
    document.addEventListener('visibilitychange', function() {
      if (!document.hidden) poll();
    });
  }
})();
</script>
</div>
</body>
</html>`;
}

module.exports = { header, footer, flash, popFlashes, APP_NAME };
