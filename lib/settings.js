const { query } = require('./db');

async function getSetting(key, def = '') {
  const { rows } = await query('SELECT value FROM settings WHERE key = $1', [key]);
  return rows.length ? rows[0].value : def;
}

async function setSetting(key, value) {
  await query(
    `INSERT INTO settings (key, value) VALUES ($1,$2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value]
  );
}

async function logRun(zoneId, programId, action, minutes, triggeredBy, status, message) {
  await query(
    `INSERT INTO run_log (zone_id, program_id, action, duration_minutes, triggered_by, status, message)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [zoneId, programId, action, minutes, triggeredBy, status, message]
  );
}

module.exports = { getSetting, setSetting, logRun };
