'use strict';
/** Admin portal. */

const express = require('express');
const db = require('../../db/pool');
const { requireAdmin } = require('../../middleware/auth');
const audit = require('../../lib/audit');

const router = express.Router();

router.use(requireAdmin);

router.get('/', async (req, res, next) => {
  try {
    const [counts, year, recentSubmissions, recentAudit, lastImport] = await Promise.all([
      db.one(`
        SELECT
          (SELECT count(*)::int FROM students WHERE is_active)        AS students,
          (SELECT count(*)::int FROM classes)                         AS classes,
          (SELECT count(*)::int FROM teachers WHERE is_active)        AS teachers,
          (SELECT count(*)::int FROM subjects WHERE is_active)        AS subjects,
          (SELECT count(*)::int FROM mark_submissions)                AS submissions
      `),
      db.one('SELECT * FROM academic_years WHERE is_active LIMIT 1'),
      db.many(`
        SELECT s.id, s.term, s.submitted_at, s.updated_at,
               c.name AS class_name, c.division AS class_division,
               subj.name AS subject_name, t.name AS teacher_name,
               (SELECT count(*)::int FROM marks m WHERE m.submission_id = s.id) AS student_count
          FROM mark_submissions s
          JOIN classes  c    ON c.id = s.class_id
          JOIN subjects subj ON subj.id = s.subject_id
          JOIN teachers t    ON t.id = s.teacher_id
         ORDER BY s.submitted_at DESC
         LIMIT 8
      `),
      audit.recent(6),
      db.one('SELECT * FROM import_batches ORDER BY created_at DESC LIMIT 1'),
    ]);

    return res.render('admin/dashboard', {
      title: 'Admin Dashboard',
      counts,
      year,
      recentSubmissions,
      recentAudit,
      lastImport,
    });
  } catch (err) {
    return next(err);
  }
});

router.use('/years', require('./years'));
router.use('/classes', require('./classes'));
router.use('/subjects', require('./subjects'));
router.use('/teachers', require('./teachers'));
router.use('/students', require('./students'));
router.use('/settings', require('./settings'));
router.use('/marks', require('./marks'));

module.exports = router;
