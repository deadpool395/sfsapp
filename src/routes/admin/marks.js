'use strict';
/**
 * Admin oversight of mark submissions: see who entered what, export reports,
 * override individual marks (audited), or release a submission so the teacher
 * can enter it again.
 */

const express = require('express');

const db = require('../../db/pool');
const marksService = require('../../services/marks');
const reports = require('../../services/reports');
const audit = require('../../lib/audit');
const { parseMarkRows, rawValues } = require('../../lib/markInput');
const { componentLabel, termLabel } = require('../../lib/terms');
const { formatClassLabel } = require('../../lib/classes');

const router = express.Router();

/** Dropdown data for the filter bar. */
async function filterContext(yearId) {
  const [years, subjects, teachers] = await Promise.all([
    marksService.listYears(),
    marksService.listSubjects({ activeOnly: false }),
    db.many('SELECT id, name FROM teachers ORDER BY name'),
  ]);
  const classes = yearId ? await marksService.listClasses(yearId) : [];
  return { years, subjects, teachers, classes };
}

function readFilters(query) {
  return {
    year: query.year || '',
    class: query.class || '',
    subject: query.subject || '',
    term: query.term || '',
    teacher: query.teacher || '',
  };
}

function toServiceFilters(f) {
  return {
    yearId: f.year || undefined,
    classId: f.class || undefined,
    subjectId: f.subject || undefined,
    term: f.term || undefined,
    teacherId: f.teacher || undefined,
  };
}

/* -------------------------------------------------------------------- list -- */

router.get('/', async (req, res, next) => {
  try {
    const filters = readFilters(req.query);
    const ctx = await filterContext(filters.year);
    const submissions = await marksService.listSubmissions(toServiceFilters(filters));

    // Coverage: how many class x subject x term combinations are still missing.
    const expected = await db.one(
      `SELECT (SELECT count(*)::int FROM classes WHERE $1::int IS NULL OR academic_year_id = $1) *
              (SELECT count(*)::int FROM subjects WHERE is_active) * 3 AS n`,
      [filters.year || null]
    );

    return res.render('admin/marks', {
      title: 'Mark Submissions',
      wide: true,
      ...ctx,
      submissions,
      filters,
      expectedTotal: expected.n,
    });
  } catch (err) {
    return next(err);
  }
});

/** Summary of the current filter as an Excel workbook. */
router.get('/export', async (req, res, next) => {
  try {
    const submissions = await marksService.listSubmissions(toServiceFilters(readFilters(req.query)));
    const { buffer, filename } = await reports.buildSubmissionsExcel(submissions, {
      schoolName: res.locals.schoolName,
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(Buffer.from(buffer));
  } catch (err) {
    return next(err);
  }
});

/* ------------------------------------------------------------------ detail -- */

async function loadOrFail(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    req.flash('error', 'Unknown submission.');
    res.redirect('/admin/marks');
    return null;
  }
  const data = await marksService.loadReport(id);
  if (!data) {
    req.flash('error', 'That submission no longer exists.');
    res.redirect('/admin/marks');
    return null;
  }
  return data;
}

router.get('/:id(\\d+)', async (req, res, next) => {
  try {
    const data = await loadOrFail(req, res);
    if (!data) return undefined;

    const history = await audit.forEntity('mark_submission', data.submission.id);
    return res.render('admin/marks-detail', {
      title: 'Submission',
      wide: true,
      data,
      history,
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/:id(\\d+)/excel', async (req, res, next) => {
  try {
    const data = await loadOrFail(req, res);
    if (!data) return undefined;
    const { buffer, filename } = await reports.buildExcel(data, { schoolName: res.locals.schoolName });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(Buffer.from(buffer));
  } catch (err) {
    return next(err);
  }
});

router.get('/:id(\\d+)/pdf', async (req, res, next) => {
  try {
    const data = await loadOrFail(req, res);
    if (!data) return undefined;
    return reports.streamPdf(data, { schoolName: res.locals.schoolName, res });
  } catch (err) {
    return next(err);
  }
});

/* ------------------------------------------------------------------- edit --- */

router.get('/:id(\\d+)/edit', async (req, res, next) => {
  try {
    const data = await loadOrFail(req, res);
    if (!data) return undefined;

    return res.render('admin/marks-edit', {
      title: 'Edit Marks',
      wide: true,
      data,
      secondaryLabel: componentLabel(data.submission.secondary_component),
      values: {},
      errors: [],
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/:id(\\d+)/edit', async (req, res, next) => {
  try {
    const data = await loadOrFail(req, res);
    if (!data) return undefined;

    const submission = data.submission;
    const secondaryLabel = componentLabel(submission.secondary_component);

    // Validate against the maxima this submission was recorded under, not the
    // current defaults, so an old submission stays internally consistent.
    const unitMax = Number(submission.unit_test_max);
    const secMax = Number(submission.secondary_max);

    const before = await marksService.getSubmissionMarks(submission.id);
    const roster = before.map((r) => ({ id: r.student_id, full_name: r.full_name }));

    const { rows, errors } = parseMarkRows({
      body: req.body,
      roster,
      unitMax,
      secMax,
      secondaryLabel,
    });

    if (errors.length) {
      return res.status(400).render('admin/marks-edit', {
        title: 'Edit Marks',
        wide: true,
        data,
        secondaryLabel,
        values: rawValues({ body: req.body, roster }),
        errors,
      });
    }

    const changed = await marksService.updateMarks({
      submissionId: submission.id,
      rows,
      actor: req.session.user,
      before,
    });

    if (changed) {
      req.flash('success', `${changed} mark${changed === 1 ? '' : 's'} updated. The change is recorded in the audit trail.`);
    } else {
      req.flash('success', 'No marks were different, so nothing changed.');
    }
    return res.redirect(`/admin/marks/${submission.id}`);
  } catch (err) {
    return next(err);
  }
});

/* ---------------------------------------------------------------- release --- */

router.post('/:id(\\d+)/release', async (req, res, next) => {
  try {
    const data = await loadOrFail(req, res);
    if (!data) return undefined;

    const s = data.submission;
    const label = `${formatClassLabel({ name: s.class_name, division: s.class_division })} — ${s.subject_name} — ${termLabel(s.term)}`;

    if (String(req.body.confirm || '').trim().toUpperCase() !== 'RELEASE') {
      req.flash('error', 'Type RELEASE to confirm. The existing marks will be deleted.');
      return res.redirect(`/admin/marks/${s.id}`);
    }

    await marksService.releaseSubmission({ submissionId: s.id, actor: req.session.user });

    req.flash(
      'success',
      `Released <strong>${label}</strong>. ${s.teacher_name} (or any teacher) can now enter these marks again. ` +
        'The deleted marks are kept in the audit trail.'
    );
    return res.redirect('/admin/marks');
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
