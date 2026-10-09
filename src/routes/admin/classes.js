'use strict';
/** Classes within an academic year. */

const express = require('express');
const db = require('../../db/pool');
const { parseClassLabel, classSortOrder, formatClassLabel, CLASS_SEQUENCE } = require('../../lib/classes');

const router = express.Router();

/** The year being managed: ?year=, else the active one, else the newest. */
async function currentYear(req) {
  if (req.query.year || req.body.year) {
    const found = await db.one('SELECT * FROM academic_years WHERE id = $1', [
      req.query.year || req.body.year,
    ]);
    if (found) return found;
  }
  return (
    (await db.one('SELECT * FROM academic_years WHERE is_active LIMIT 1')) ||
    (await db.one('SELECT * FROM academic_years ORDER BY name DESC LIMIT 1'))
  );
}

router.get('/', async (req, res, next) => {
  try {
    const years = await db.many('SELECT * FROM academic_years ORDER BY name DESC');
    const year = await currentYear(req);

    const classes = year
      ? await db.many(
          `SELECT c.*,
                  (SELECT count(*)::int FROM students st WHERE st.class_id = c.id AND st.is_active) AS student_count,
                  (SELECT count(*)::int FROM mark_submissions s WHERE s.class_id = c.id) AS submission_count
             FROM classes c
            WHERE c.academic_year_id = $1
            ORDER BY c.sort_order, c.name, c.division`,
          [year.id]
        )
      : [];

    return res.render('admin/classes', {
      title: 'Classes',
      years,
      year,
      classes,
      classSequence: CLASS_SEQUENCE,
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const year = await currentYear(req);
    if (!year) {
      req.flash('error', 'Create an academic year first.');
      return res.redirect('/admin/years');
    }

    // Accepts either a combined label ("LKG A") or separate name + division.
    const combined = String(req.body.label || '').trim();
    const parsed = combined
      ? parseClassLabel(combined)
      : parseClassLabel(`${String(req.body.name || '').trim()} ${String(req.body.division || '').trim()}`.trim());

    if (!parsed.name) {
      req.flash('error', 'Enter a class, for example "LKG A" or "VIII C".');
      return res.redirect(`/admin/classes?year=${year.id}`);
    }

    const result = await db.query(
      `INSERT INTO classes (academic_year_id, name, division, sort_order)
            VALUES ($1, $2, $3, $4)
       ON CONFLICT (academic_year_id, name, division) DO NOTHING`,
      [year.id, parsed.name, parsed.division, classSortOrder(parsed.name)]
    );

    if (result.rowCount) req.flash('success', `Added ${formatClassLabel(parsed)} to ${year.name}.`);
    else req.flash('error', `${formatClassLabel(parsed)} already exists in ${year.name}.`);

    return res.redirect(`/admin/classes?year=${year.id}`);
  } catch (err) {
    return next(err);
  }
});

router.post('/:id(\\d+)', async (req, res, next) => {
  try {
    const cls = await db.one('SELECT * FROM classes WHERE id = $1', [req.params.id]);
    if (!cls) {
      req.flash('error', 'That class no longer exists.');
      return res.redirect('/admin/classes');
    }

    const parsed = parseClassLabel(
      `${String(req.body.name || cls.name).trim()} ${String(req.body.division ?? cls.division).trim()}`.trim()
    );

    await db.query(
      'UPDATE classes SET name = $1, division = $2, sort_order = $3 WHERE id = $4',
      [parsed.name, parsed.division, classSortOrder(parsed.name), cls.id]
    );
    req.flash('success', `Class renamed to ${formatClassLabel(parsed)}.`);
    return res.redirect(`/admin/classes?year=${cls.academic_year_id}`);
  } catch (err) {
    return next(err);
  }
});

router.post('/:id(\\d+)/delete', async (req, res, next) => {
  try {
    const cls = await db.one('SELECT * FROM classes WHERE id = $1', [req.params.id]);
    if (!cls) {
      req.flash('error', 'That class no longer exists.');
      return res.redirect('/admin/classes');
    }

    const counts = await db.one(
      `SELECT (SELECT count(*)::int FROM students WHERE class_id = $1) AS students,
              (SELECT count(*)::int FROM mark_submissions WHERE class_id = $1) AS submissions`,
      [cls.id]
    );

    if (counts.submissions) {
      req.flash(
        'error',
        `${formatClassLabel(cls)} has ${counts.submissions} mark submission(s). Release those first if you really need to delete the class.`
      );
      return res.redirect(`/admin/classes?year=${cls.academic_year_id}`);
    }
    if (counts.students && String(req.body.confirm || '').trim().toLowerCase() !== 'delete') {
      req.flash(
        'error',
        `${formatClassLabel(cls)} still has ${counts.students} student(s). Type DELETE to confirm — the students will be left without a class.`
      );
      return res.redirect(`/admin/classes?year=${cls.academic_year_id}`);
    }

    await db.query('DELETE FROM classes WHERE id = $1', [cls.id]);
    req.flash('success', `Deleted ${formatClassLabel(cls)}.`);
    return res.redirect(`/admin/classes?year=${cls.academic_year_id}`);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
