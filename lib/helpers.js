const crypto = require('crypto');
const { DateTime } = require('luxon');

const TZ = 'America/New_York';
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function e(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function csrfToken(req) {
  if (!req.session.csrf) {
    req.session.csrf = crypto.randomBytes(24).toString('hex');
  }
  return req.session.csrf;
}

function csrfField(req) {
  return `<input type="hidden" name="csrf" value="${e(csrfToken(req))}">`;
}

function requireCsrf(req, res, next) {
  if ((req.body && req.body.csrf) !== req.session.csrf) {
    return res.status(400).send('Session expired or invalid request. Please go back and try again.');
  }
  next();
}

function daysMaskFromArray(days) {
  let mask = 0;
  for (const d of days) mask |= (1 << Number(d));
  return mask;
}

function daysMaskToLabels(mask) {
  const out = [];
  DAY_LABELS.forEach((label, i) => {
    if (mask & (1 << i)) out.push(label);
  });
  return out.length ? out.join(' ') : 'Never';
}

/** Next upcoming run time (JS ms epoch) for a program, in America/New_York. */
function nextRunTs(program) {
  if (!program.enabled || program.days_mask === 0) return null;
  const [h, m] = program.start_time.split(':').map(Number);
  const now = DateTime.now().setZone(TZ);
  for (let offset = 0; offset <= 7; offset++) {
    let candidate = now.plus({ days: offset }).set({ hour: h, minute: m, second: 0, millisecond: 0 });
    const dow = candidate.weekday % 7; // luxon: Mon=1..Sun=7 -> convert to Sun=0..Sat=6
    if ((program.days_mask & (1 << dow)) && candidate.toMillis() > now.toMillis()) {
      return candidate.toMillis();
    }
  }
  return null;
}

function fmtTime(ts) {
  return DateTime.fromMillis(ts).setZone(TZ).toFormat('h:mm a');
}
function fmtDayTime(ts) {
  return DateTime.fromMillis(ts).setZone(TZ).toFormat('ccc, LLL d h:mm a');
}
function fmtLogTime(ts) {
  return DateTime.fromJSDate(new Date(ts)).setZone(TZ).toFormat('LLL d, h:mm:ss a');
}

module.exports = {
  TZ, DAY_LABELS, e, csrfToken, csrfField, requireCsrf,
  daysMaskFromArray, daysMaskToLabels, nextRunTs, fmtTime, fmtDayTime, fmtLogTime,
};
