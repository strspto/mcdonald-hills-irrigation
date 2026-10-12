// Health alerts for the wireless irrigation system.
//
// Runs inside the web app (not on the Pi) once a minute, so it still works
// when the Pi, its power, or its internet connection is the thing that broke.
// Sends phone notifications through ntfy (https://ntfy.sh): free, no account;
// install the ntfy app on the phone and subscribe to the secret topic name.
//
// Setup (Render environment variables):
//   ALERT_NTFY_TOPIC   required. A long, hard-to-guess name, e.g. mhgc-irrigation-x7k29q
//                      Leave unset to turn alerts off (the checks still log to the console).
//   ALERT_NTFY_SERVER  optional. Defaults to https://ntfy.sh
//
// Optional settings table keys:
//   alert_ignore_nodes   comma list of node numbers to skip (e.g. "11" while a node is
//                        built but not installed on the course)
//
// What it watches:
//   gateway     Node 0 heartbeat missing  -> the Pi/radio/internet is down
//   node        a node with an enabled radio zone has not been heard from
//   battery     a node reports a battery voltage under the low threshold
//   failures    a node fails to answer commands repeatedly
//   queue       commands sitting 'pending' because nothing is picking them up
//
// Each problem alerts once when it starts, repeats at most every REPEAT_HOURS while it
// lasts, and sends an "OK again" message when it clears. State is kept in the settings
// table so a restart of the app does not re-send everything.

const { query } = require('./db');
const { getSetting, setSetting } = require('./settings');

const NODE_SILENT_MIN = 10;      // nodes send a heartbeat each minute
const GATEWAY_SILENT_MIN = 5;
const LOW_BATTERY_V = 12.5;      // 12V LiFePO4: at or below ~12.0V is nearly empty
const FAIL_WINDOW_MIN = 60;
const FAIL_COUNT = 3;            // failures with no success in the window
const PENDING_STUCK_MIN = 3;
const REPEAT_HOURS = 6;
const STATE_KEY = 'alert_state';

async function sendPhone(title, message, priority) {
  const topic = process.env.ALERT_NTFY_TOPIC;
  if (!topic) {
    console.log(`[alerts] (no ALERT_NTFY_TOPIC set) ${title}: ${message}`);
    return true;
  }
  const server = (process.env.ALERT_NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
  try {
    const res = await fetch(`${server}/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: {
        Title: title,
        Priority: String(priority || 3),
        Tags: priority >= 4 ? 'warning' : 'white_check_mark',
      },
      body: message,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) { console.error('[alerts] ntfy returned', res.status); return false; }
    return true;
  } catch (err) {
    console.error('[alerts] could not send notification:', err.message);
    return false;
  }
}

async function loadState() {
  try {
    return JSON.parse(await getSetting(STATE_KEY, '{}')) || {};
  } catch (_) {
    return {};
  }
}

// Work out the list of current problems: { key: { title, message } }
async function findProblems() {
  const problems = {};
  const ignore = (await getSetting('alert_ignore_nodes', ''))
    .split(',').map((s) => parseInt(s, 10)).filter((n) => !Number.isNaN(n));

  const { rows: nodes } = await query('SELECT node_id, name, last_seen, battery_v FROM radio_nodes');
  const byId = new Map(nodes.map((n) => [n.node_id, n]));
  const ageMin = (n) => (n && n.last_seen ? (Date.now() - new Date(n.last_seen).getTime()) / 60000 : Infinity);

  // Gateway
  const gw = byId.get(0);
  const gwAge = ageMin(gw);
  const gatewayDown = gwAge > GATEWAY_SILENT_MIN;
  if (gatewayDown) {
    problems.gateway = {
      title: 'Irrigation gateway offline',
      message: gw && gw.last_seen
        ? `The clubhouse Pi has not checked in for ${Math.round(gwAge)} min. No wireless holes can be started. Check Pi power and internet.`
        : 'The clubhouse Pi has never checked in.',
    };
  }

  // Nodes that have an enabled zone assigned to them
  const { rows: assigned } = await query(
    `SELECT DISTINCT lora_node_id AS node_id FROM zones WHERE lora_node_id IS NOT NULL AND enabled`
  );
  const watched = assigned.map((r) => r.node_id).filter((id) => !ignore.includes(id));

  for (const id of watched) {
    const n = byId.get(id);
    const age = ageMin(n);
    const label = `Hole ${id}`;
    // If the gateway itself is down, every node looks silent; report only the gateway.
    if (!gatewayDown && age > NODE_SILENT_MIN) {
      problems[`node:${id}`] = {
        title: `${label} not responding`,
        message: n && n.last_seen
          ? `${label} has not been heard from in ${Math.round(age)} min. Likely battery, converter, or antenna. It will not water until it is back.`
          : `${label} has never been heard from.`,
      };
    }
    // battery_v of 0 means the firmware is not reporting it yet: ignore.
    if (n && n.battery_v != null && Number(n.battery_v) > 0 && Number(n.battery_v) < LOW_BATTERY_V && age <= NODE_SILENT_MIN) {
      problems[`battery:${id}`] = {
        title: `${label} battery low`,
        message: `${label} battery is ${Number(n.battery_v).toFixed(2)} V (alert below ${LOW_BATTERY_V} V). Check the panel and battery before it shuts down.`,
      };
    }
  }

  // Repeated command failures with no success since
  const { rows: fails } = await query(
    `SELECT node_id,
            COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
            COUNT(*) FILTER (WHERE status = 'acked')::int  AS acked
       FROM radio_commands
      WHERE action = 'run' AND created_at > now() - ($1 || ' minutes')::interval
      GROUP BY node_id`,
    [String(FAIL_WINDOW_MIN)]
  );
  for (const f of fails) {
    if (ignore.includes(f.node_id)) continue;
    if (f.failed >= FAIL_COUNT && f.acked === 0 && !problems[`node:${f.node_id}`] && !gatewayDown) {
      problems[`fail:${f.node_id}`] = {
        title: `Hole ${f.node_id} commands failing`,
        message: `${f.failed} start commands to Hole ${f.node_id} got no answer in the last hour and none succeeded, even though it is checking in. Check its power and valve wiring.`,
      };
    }
  }

  // Commands stuck waiting for the Pi
  const { rows: stuck } = await query(
    `SELECT COUNT(*)::int AS c FROM radio_commands
      WHERE status = 'pending' AND created_at < now() - ($1 || ' minutes')::interval`,
    [String(PENDING_STUCK_MIN)]
  );
  if (stuck[0].c > 0 && !problems.gateway) {
    problems.queue = {
      title: 'Radio commands are stuck',
      message: `${stuck[0].c} command(s) have been waiting over ${PENDING_STUCK_MIN} min for the Pi to send them. The Pi is checking in but not sending: restart the lora-gateway service.`,
    };
  }

  return problems;
}

async function alertsTick() {
  let problems;
  try {
    problems = await findProblems();
  } catch (err) {
    console.error('[alerts] check failed:', err.message);
    return;
  }

  const state = await loadState();      // { key: lastSentMs }
  const now = Date.now();
  const next = {};

  for (const [key, p] of Object.entries(problems)) {
    const last = state[key];
    if (!last || now - last > REPEAT_HOURS * 3600 * 1000) {
      const ok = await sendPhone(p.title, p.message, 4);
      if (ok) next[key] = now;      // not recorded if the send failed, so it retries next minute
    } else {
      next[key] = last;
    }
  }

  for (const key of Object.keys(state)) {
    if (!problems[key]) {
      await sendPhone(`OK again: ${key.replace(':', ' ')}`, 'This problem has cleared.', 2);
    }
  }

  if (JSON.stringify(next) !== JSON.stringify(state)) {
    await setSetting(STATE_KEY, JSON.stringify(next));
  }
}

function startAlerts() {
  // Wait a few minutes after boot so a restart of the app does not look like a
  // gateway outage before the Pi has had a chance to check in again.
  setTimeout(() => {
    alertsTick();
    setInterval(alertsTick, 60000);
  }, 3 * 60000);
}

module.exports = { startAlerts, alertsTick, findProblems, sendPhone };
