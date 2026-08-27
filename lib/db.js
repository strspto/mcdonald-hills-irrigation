const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('supabase')
    ? { rejectUnauthorized: false }
    : undefined,
});

async function query(text, params) {
  return pool.query(text, params);
}

async function ensureSeeded() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);

  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM users');
  if (rows[0].c > 0) return; // already seeded

  const adminHash = await bcrypt.hash('changeme123', 10);
  const crewHash = await bcrypt.hash('changeme123', 10);

  await pool.query(
    `INSERT INTO users (username, password_hash, full_name, role, must_change_password)
     VALUES ($1,$2,$3,$4,true)`,
    ['admin', adminHash, 'Course Admin', 'admin']
  );
  await pool.query(
    `INSERT INTO users (username, password_hash, full_name, role, must_change_password)
     VALUES ($1,$2,$3,$4,true)`,
    ['crew', crewHash, 'Grounds Crew', 'crew']
  );

  for (let i = 1; i <= 24; i++) {
    await pool.query('INSERT INTO zones (number, name) VALUES ($1,$2)', [i, `Zone ${i}`]);
  }

  await pool.query(
    `INSERT INTO settings (key, value) VALUES ($1,$2),($3,$4),($5,$6)`,
    ['mock_mode', '1', 'hydrawise_api_key', '', 'controller_serial', '']
  );

  console.log('Database seeded: default users, 24 zones, settings.');
}

module.exports = { pool, query, ensureSeeded };
