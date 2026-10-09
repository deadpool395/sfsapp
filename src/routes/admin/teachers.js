'use strict';
/** Teacher records. These populate the post-login name dropdown. */

const express = require('express');
const db = require('../../db/pool');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const teachers = await db.many(`
      SELECT t.*,
             (SELECT count(*)::int FROM mark_submissions s WHERE s.teacher_id = t.id) AS submission_count,
             (SELECT max(s.submitted_at) FROM mark_submissions s WHERE s.teacher_id = t.id) AS last_submission
        FROM teachers t
       ORDER BY t.is_active DESC, t.name
    `);
    return res.render('admin/teachers', { title: 'Teachers', teachers });
  } catch (err) {
    return next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const name = String(req.body.name || '').replace(/\s+/g, ' ').trim();
    if (!name) {
      req.flash('error', 'Enter the teacher’s name.');
      return res.redirect('/admin/teachers');
    }

    const existing = await db.one('SELECT id FROM teachers WHERE lower(name) = lower($1)', [name]);
    if (existing) {
      req.flash('error', `A teacher named "${name}" already exists.`);
      return res.redirect('/admin/teachers');
    }

    await db.query(
      'INSERT INTO teachers (name, employee_code, email, phone) VALUES ($1, $2, $3, $4)',
      [
        name,
        String(req.body.employee_code || '').trim() || null,
        String(req.body.email || '').trim() || null,
        String(req.body.phone || '').trim() || null,
      ]
    );
    req.flash('success', `Added ${name}.`);
    return res.redirect('/admin/teachers');
  } catch (err) {
    return next(err);
  }
});

router.post('/:id(\\d+)', async (req, res, next) => {
  try {
    const teacher = await db.one('SELECT * FROM teachers WHERE id = $1', [req.params.id]);
    if (!teacher) {
      req.flash('error', 'That teacher no longer exists.');
      return res.redirect('/admin/teachers');
    }

    await db.query(
      `UPDATE teachers SET name = $1, employee_code = $2, email = $3, phone = $4, is_active = $5
        WHERE id = $6`,
      [
        String(req.body.name || '').replace(/\s+/g, ' ').trim() || teacher.name,
        String(req.body.employee_code || '').trim() || null,
        String(req.body.email || '').trim() || null,
        String(req.body.phone || '').trim() || null,
        req.body.is_active === 'on',
        teacher.id,
      ]
    );
    req.flash('success', 'Teacher updated.');
    return res.redirect('/admin/teachers');
  } catch (err) {
    return next(err);
  }
});

router.post('/:id(\\d+)/delete', async (req, res, next) => {
  try {
    const used = await db.one(
      'SELECT count(*)::int AS n FROM mark_submissions WHERE teacher_id = $1',
      [req.params.id]
    );
    if (used.n) {
      req.flash(
        'error',
        `That teacher has ${used.n} mark submission(s) on record, so the account is kept for audit. Mark them inactive instead.`
      );
      return res.redirect('/admin/teachers');
    }

    await db.query('DELETE FROM teachers WHERE id = $1', [req.params.id]);
    req.flash('success', 'Teacher removed.');
    return res.redirect('/admin/teachers');
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
