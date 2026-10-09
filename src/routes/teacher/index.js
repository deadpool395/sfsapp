'use strict';
/** Teacher area. Everything here needs a chosen teacher identity. */

const express = require('express');
const db = require('../../db/pool');
const { requireTeacher } = require('../../middleware/auth');

const router = express.Router();

router.use(requireTeacher);

router.get('/', async (req, res, next) => {
  try {
    const mine = await db.one(
      'SELECT count(*)::int AS n FROM mark_submissions WHERE teacher_id = $1',
      [req.session.user.teacherId]
    );
    return res.render('teacher/dashboard', {
      title: 'Dashboard',
      submissionCount: mine.n,
    });
  } catch (err) {
    return next(err);
  }
});

router.use('/marks', require('./marks'));

module.exports = router;
