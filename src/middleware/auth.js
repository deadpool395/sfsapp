'use strict';
/** Session guards for the admin portal and the teacher area. */

function wantsJson(req) {
  return req.xhr || (req.get('accept') || '').includes('application/json');
}

function deny(req, res, redirectTo) {
  if (wantsJson(req)) return res.status(401).json({ error: 'not signed in' });
  if (req.method === 'GET') req.session.returnTo = req.originalUrl;
  req.flash('error', 'Please sign in to continue.');
  return res.redirect(redirectTo);
}

/** Any signed-in user. */
function requireAuth(req, res, next) {
  if (!req.session.user) return deny(req, res, '/login');
  return next();
}

function requireAdmin(req, res, next) {
  const user = req.session.user;
  if (!user) return deny(req, res, '/login');
  if (user.role !== 'admin') {
    req.flash('error', 'That area is for administrators.');
    return res.redirect('/teacher');
  }
  return next();
}

/**
 * A signed-in teacher who has identified themselves from the dropdown.
 * Logged in but unidentified teachers are sent to pick a name first.
 */
function requireTeacher(req, res, next) {
  const user = req.session.user;
  if (!user) return deny(req, res, '/login');
  if (user.role === 'admin') {
    req.flash('error', 'Sign in as a teacher to enter marks.');
    return res.redirect('/admin');
  }
  if (!user.teacherId) return res.redirect('/select-teacher');
  return next();
}

/** Signed in with the shared teacher credentials; name not yet chosen. */
function requireTeacherLogin(req, res, next) {
  const user = req.session.user;
  if (!user || user.role !== 'teacher') return deny(req, res, '/login');
  return next();
}

module.exports = { requireAuth, requireAdmin, requireTeacher, requireTeacherLogin };
