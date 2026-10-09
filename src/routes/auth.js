'use strict';
/** Login, teacher identification, logout. */

const express = require('express');
const bcrypt = require('bcryptjs');

const db = require('../db/pool');
const settingsStore = require('../lib/settings');
const { requireTeacherLogin } = require('../middleware/auth');

const router = express.Router();

/** Send a signed-in user to their home area. */
function homeFor(user) {
  if (!user) return '/login';
  if (user.role === 'admin') return '/admin';
  return user.teacherId ? '/teacher' : '/select-teacher';
}

router.get('/', (req, res) => res.redirect(homeFor(req.session.user)));

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect(homeFor(req.session.user));
  return res.render('auth/login', {
    title: 'Sign in',
    mode: req.query.mode === 'admin' ? 'admin' : 'teacher',
    username: '',
  });
});

router.post('/login', async (req, res, next) => {
  try {
    const mode = req.body.mode === 'admin' ? 'admin' : 'teacher';
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');

    // flashNow, not flash: this re-renders the page rather than redirecting,
    // so the message has to be visible on this response.
    const reject = (message) => {
      res.flashNow('error', message);
      return res.status(401).render('auth/login', { title: 'Sign in', mode, username });
    };

    if (!username || !password) return reject('Incorrect username or password.');

    if (mode === 'admin') {
      const admin = await db.one(
        'SELECT id, username, password_hash, full_name FROM admins WHERE lower(username) = lower($1)',
        [username]
      );
      // Compare against a dummy hash when the user is unknown so that a wrong
      // username and a wrong password take about the same time.
      const hash = admin ? admin.password_hash : '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
      // One message for both cases, so it never reveals which field was wrong.
      if (!bcrypt.compareSync(password, hash) || !admin) {
        return reject('Incorrect username or password.');
      }

      req.session.user = {
        role: 'admin',
        adminId: admin.id,
        displayName: admin.full_name || admin.username,
      };
    } else {
      const ok = await settingsStore.checkTeacherPassword(username, password);
      if (!ok) return reject('Incorrect username or password.');

      req.session.user = { role: 'teacher', teacherId: null, teacherName: null, displayName: 'Teacher' };
    }

    const target = req.session.returnTo;
    delete req.session.returnTo;
    return res.redirect(target || homeFor(req.session.user));
  } catch (err) {
    return next(err);
  }
});

/* --------------------------------------------- teacher identity selection -- */

router.get('/select-teacher', requireTeacherLogin, async (req, res, next) => {
  try {
    const teachers = await db.many(
      'SELECT id, name FROM teachers WHERE is_active ORDER BY name'
    );
    return res.render('auth/select-teacher', {
      title: 'Who are you?',
      teachers,
      selectedId: req.session.user.teacherId || '',
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/select-teacher', requireTeacherLogin, async (req, res, next) => {
  try {
    const teacherId = Number(req.body.teacher_id);
    const teacher = Number.isInteger(teacherId)
      ? await db.one('SELECT id, name FROM teachers WHERE id = $1 AND is_active', [teacherId])
      : null;

    if (!teacher) {
      req.flash('error', 'Please choose your name from the list.');
      return res.redirect('/select-teacher');
    }

    req.session.user = {
      ...req.session.user,
      teacherId: teacher.id,
      teacherName: teacher.name,
      displayName: teacher.name,
    };

    const target = req.session.returnTo;
    delete req.session.returnTo;
    return res.redirect(target || '/teacher');
  } catch (err) {
    return next(err);
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
