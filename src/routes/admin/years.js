'use strict';
/** Academic years: create, rename, set active, delete. */

const express = require('express');
const db = require('../../db/pool');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const years = await db.many(`
      SELECT ay.*,
             (SELECT count(*)::int FROM classes  c  WHERE c.academic_year_id  = ay.id) AS class_count,
             (SELECT count(*)::int FROM students st WHERE st.academic_year_id = ay.id AND st.is_active) AS student_count,
             (SELECT count(*)::int FROM mark_submissions s WHERE s.academic_year_id = ay.id) AS submission_count
        FROM academic_years ay
       ORDER BY ay.name DESC
    `);
    return res.render('admin/years', { title: 'Academic Years', years });
  } catch (err) {
    return next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!/^\d{4}-\d{4}$/.test(name)) {
      req.flash('error', 'Use the format 2026-2027 for the academic year.');
      return res.redirect('/admin/years');
    }

    await db.query(
      `INSERT INTO academic_years (name, start_date, end_date) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO NOTHING`,
      [name, req.body.start_date || null, req.body.end_date || null]
    );
    req.flash('success', `Academic year ${name} saved.`);
    return res.redirect('/admin/years');
  } catch (err) {
    return next(err);
  }
});

router.post('/:id(\\d+)/activate', async (req, res, next) => {
  try {
    // The partial unique index allows only one active year, so clear first.
    await db.transaction(async (c) => {
      await c.query('UPDATE academic_years SET is_active = FALSE WHERE is_active');
      await c.query('UPDATE academic_years SET is_active = TRUE WHERE id = $1', [req.params.id]);
    });
    req.flash('success', 'Current academic year updated.');
    return res.redirect('/admin/years');
  } catch (err) {
    return next(err);
  }
});

router.post('/:id(\\d+)/delete', async (req, res, next) => {
  try {
    const year = await db.one('SELECT * FROM academic_years WHERE id = $1', [req.params.id]);
    if (!year) {
      req.flash('error', 'That academic year no longer exists.');
      return res.redirect('/admin/years');
    }

    const counts = await db.one(
      `SELECT (SELECT count(*)::int FROM students WHERE academic_year_id = $1) AS students,
              (SELECT count(*)::int FROM mark_submissions WHERE academic_year_id = $1) AS submissions`,
      [year.id]
    );

    // Deleting cascades to classes, students and marks, so make the operator
    // confirm by typing the year name when there is data attached.
    if ((counts.students || counts.submissions) && String(req.body.confirm || '').trim() !== year.name) {
      req.flash(
        'error',
        `${year.name} holds ${counts.students} students and ${counts.submissions} mark submissions. ` +
          'Type the year name exactly to confirm deletion.'
      );
      return res.redirect('/admin/years');
    }

    await db.query('DELETE FROM academic_years WHERE id = $1', [year.id]);
    req.flash('success', `Deleted ${year.name} and everything under it.`);
    return res.redirect('/admin/years');
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
