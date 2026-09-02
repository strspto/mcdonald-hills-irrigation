const bcrypt = require('bcryptjs');
const { query } = require('./db');

function currentUser(req) {
  return req.session.user || null;
}

function requireLogin(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.redirect('/login');
  if (u.must_change_password && !['/account', '/logout'].includes(req.path)) {
    return res.redirect('/account');
  }
  req.user = u;
  next();
}

function requireAdmin(req, res, next) {
  requireLogin(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).send(
        '<p style="font-family:sans-serif;padding:2rem">You need an admin account to view this page. Ask your course admin for access.</p>'
      );
    }
    next();
  });
}

async function attemptLogin(req, username, password) {
  const { rows } = await query('SELECT * FROM users WHERE username = $1', [username]);
  const user = rows[0];
  if (user && (await bcrypt.compare(password, user.password_hash))) {
    await new Promise((resolve, reject) => {
      req.session.regenerate((err) => {
        if (err) return reject(err);
        req.session.user = {
          id: user.id,
          username: user.username,
          full_name: user.full_name,
          role: user.role,
          must_change_password: user.must_change_password,
        };
        resolve();
      });
    });
    return true;
  }
  return false;
}

function actorLabel(req) {
  const u = currentUser(req);
  return u ? `user:${u.id}:${u.username}` : 'unknown';
}

module.exports = { currentUser, requireLogin, requireAdmin, attemptLogin, actorLabel };
