'use strict';
/** Shared teacher credentials, default maxima, admin password, school name. */

const express = require('express');
const bcrypt = require('bcryptjs');

const db = require('../../db/pool');
const settingsStore = require('../../lib/settings');
const audit = require('../../lib/audit');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const settings = await settingsStore.all({ fresh: true });
    const admins = await db.many('SELECT id, username, full_name, created_at FROM admins ORDER BY username');
    return res.render('admin/settings', { title: 'Settings', settings, admins });
  } catch (err) {
    return next(err);
  }
});

/** Maximum marks used to validate every new mark entry. */
router.post('/marks', async (req, res, next) => {
  try {
    const entries = [
      ['default_unit_test_max', req.body.default_unit_test_max],
      ['default_assignment_max', req.body.default_assignment_max],
      ['default_practical_max', req.body.default_practical_max],
    ];

    for (const [key, raw] of entries) {
      const value = Number(raw);
      if (!Number.isFinite(value) || value <= 0 || value > 1000) {
        req.flash('error', 'Maximum marks must be numbers between 1 and 1000.');
        return res.redirect('/admin/settings');
      }
      await settingsStore.set(key, value);
    }

    await audit.log({
      actor: req.session.user,
      action: 'settings.max_marks',
      entity: 'app_settings',
      details: Object.fromEntries(entries.map(([k, v]) => [k, Number(v)])),
    });

    req.flash(
      'success',
      'Default maximum marks updated. Submissions already recorded keep the maxima they were entered under.'
    );
    return res.redirect('/admin/settings');
  } catch (err) {
    return next(err);
  }
});

/** The single login shared by all teachers. */
router.post('/teacher-login', async (req, res, next) => {
  try {
    const username = String(req.body.teacher_common_username || '').trim();
    const password = String(req.body.teacher_common_password || '');
    const confirm = String(req.body.teacher_common_password_confirm || '');

    if (!username) {
      req.flash('error', 'The shared teacher username cannot be blank.');
      return res.redirect('/admin/settings');
    }

    await settingsStore.set('teacher_common_username', username);

    if (password || confirm) {
      if (password.length < 6) {
        req.flash('error', 'The shared teacher password must be at least 6 characters.');
        return res.redirect('/admin/settings');
      }
      if (password !== confirm) {
        req.flash('error', 'The two password entries did not match.');
        return res.redirect('/admin/settings');
      }
      await settingsStore.setTeacherPassword(password);
      await audit.log({
        actor: req.session.user,
        action: 'settings.teacher_password',
        entity: 'app_settings',
        details: { username },
      });
      req.flash('success', 'Shared teacher login updated. Tell staff the new password.');
    } else {
      req.flash('success', 'Shared teacher username updated.');
    }

    return res.redirect('/admin/settings');
  } catch (err) {
    return next(err);
  }
});

router.post('/school', async (req, res, next) => {
  try {
    const name = String(req.body.school_name || '').trim();
    if (!name) {
      req.flash('error', 'The school name cannot be blank.');
      return res.redirect('/admin/settings');
    }
    await settingsStore.set('school_name', name);
    req.flash('success', 'School name updated.');
    return res.redirect('/admin/settings');
  } catch (err) {
    return next(err);
  }
});

router.post('/admin-password', async (req, res, next) => {
  try {
    const current = String(req.body.current_password || '');
    const next_ = String(req.body.new_password || '');
    const confirm = String(req.body.confirm_password || '');

    const admin = await db.one('SELECT * FROM admins WHERE id = $1', [req.session.user.adminId]);
    if (!admin || !bcrypt.compareSync(current, admin.password_hash)) {
      req.flash('error', 'Your current password was not correct.');
      return res.redirect('/admin/settings');
    }
    if (next_.length < 8) {
      req.flash('error', 'Choose a new password of at least 8 characters.');
      return res.redirect('/admin/settings');
    }
    if (next_ !== confirm) {
      req.flash('error', 'The new password entries did not match.');
      return res.redirect('/admin/settings');
    }

    await db.query('UPDATE admins SET password_hash = $1 WHERE id = $2', [
      bcrypt.hashSync(next_, 10),
      admin.id,
    ]);
    await audit.log({
      actor: req.session.user,
      action: 'admin.password_change',
      entity: 'admin',
      entityId: admin.id,
    });

    req.flash('success', 'Your administrator password has been changed.');
    return res.redirect('/admin/settings');
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
