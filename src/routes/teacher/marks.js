'use strict';
/**
 * Assignment / Unit Test mark submission.
 *
 * Flow: choose year -> class -> subject -> term, then fill the roster grid.
 * A class/subject/term that already has marks is read-only; only an admin can
 * change or release it.
 */

const express = require('express');

const marksService = require('../../services/marks');
const reports = require('../../services/reports');
const settingsStore = require('../../lib/settings');
const { parseMarkRows, rawValues } = require('../../lib/markInput');
const { isTerm, termLabel, componentLabel } = require('../../lib/terms');
const { formatClassLabel } = require('../../lib/classes');

const router = express.Router();

/** Build the data the selection form needs, including classes per year. */
async function selectionContext() {
  const years = await marksService.listYears();
  const subjects = await marksService.listSubjects();

  const classesByYear = {};
  for (const year of years) {
    classesByYear[year.id] = (await marksService.listClasses(year.id)).map((c) => ({
      id: c.id,
      label: formatClassLabel(c),
    }));
  }
  return { years, subjects, classesByYear };
}

/** Validate ?year=&class=&subject=&term= into real rows. */
async function resolveSelection(query) {
  const yearId = Number(query.year);
  const classId = Number(query.class);
  const subjectId = Number(query.subject);
  const term = String(query.term || '');

  if (!Number.isInteger(yearId) || !Number.isInteger(classId) || !Number.isInteger(subjectId) || !isTerm(term)) {
    return { error: 'Choose an academic year, class, subject and term.' };
  }

  const [cls, subject] = await Promise.all([
    marksService.getClass(classId),
    marksService.getSubject(subjectId),
  ]);

  if (!cls || cls.academic_year_id !== yearId) {
    return { error: 'That class does not belong to the selected academic year.' };
  }
  if (!subject) return { error: 'That subject no longer exists.' };

  return { yearId, classId, subjectId, term, cls, subject };
}

/* ------------------------------------------------------------- selection -- */

router.get('/', async (req, res, next) => {
  try {
    const ctx = await selectionContext();
    const active = await marksService.activeYear();

    return res.render('teacher/marks-select', {
      title: 'Enter Marks',
      ...ctx,
      selected: {
        year: req.query.year || (active ? String(active.id) : ''),
        class: req.query.class || '',
        subject: req.query.subject || '',
        term: req.query.term || '',
      },
    });
  } catch (err) {
    return next(err);
  }
});

/* ----------------------------------------------------------- entry sheet -- */

router.get('/entry', async (req, res, next) => {
  try {
    const sel = await resolveSelection(req.query);
    if (sel.error) {
      req.flash('error', sel.error);
      return res.redirect('/teacher/marks');
    }

    // Already submitted? Show it read-only with the contact-admin notice.
    const existing = await marksService.findSubmission(sel);
    if (existing) {
      const data = marksService.buildReportData(existing, await marksService.getSubmissionMarks(existing.id));
      return res.render('teacher/marks-locked', {
        title: 'Already submitted',
        wide: true,
        data,
        isMine: existing.teacher_id === req.session.user.teacherId,
      });
    }

    const roster = await marksService.getRoster(sel.classId);
    const secondaryMax = await settingsStore.secondaryMaxFor(sel.subject.secondary_component);
    const { unitTest: unitTestMax } = await settingsStore.maxMarks();

    return res.render('teacher/marks-entry', {
      title: 'Enter Marks',
      wide: true,
      sel,
      roster,
      unitTestMax,
      secondaryMax,
      secondaryComponent: sel.subject.secondary_component,
      secondaryLabel: componentLabel(sel.subject.secondary_component),
      values: {},
      errors: [],
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/entry', async (req, res, next) => {
  try {
    const sel = await resolveSelection(req.body);
    if (sel.error) {
      req.flash('error', sel.error);
      return res.redirect('/teacher/marks');
    }

    const roster = await marksService.getRoster(sel.classId);
    const secondaryComponent = sel.subject.secondary_component;
    const secondaryLabel = componentLabel(secondaryComponent);

    // Maxima come from settings, not the form, so they cannot be tampered with.
    const { unitTest: unitTestMax } = await settingsStore.maxMarks();
    const secondaryMax = await settingsStore.secondaryMaxFor(secondaryComponent);

    const { rows, errors, entered } = parseMarkRows({
      body: req.body,
      roster,
      unitMax: unitTestMax,
      secMax: secondaryMax,
      secondaryLabel,
    });

    if (!entered) {
      errors.push('No marks were entered. Fill in at least one student before submitting.');
    }

    const rerender = () =>
      res.status(400).render('teacher/marks-entry', {
        title: 'Enter Marks',
        wide: true,
        sel,
        roster,
        unitTestMax,
        secondaryMax,
        secondaryComponent,
        secondaryLabel,
        values: rawValues({ body: req.body, roster }),
        errors,
      });

    if (errors.length) return rerender();

    try {
      const submission = await marksService.createSubmission({
        yearId: sel.yearId,
        classId: sel.classId,
        subjectId: sel.subjectId,
        term: sel.term,
        teacherId: req.session.user.teacherId,
        unitTestMax,
        secondaryMax,
        secondaryComponent,
        rows,
        actor: req.session.user,
      });

      req.flash(
        'success',
        `Marks submitted for <strong>${formatClassLabel(sel.cls)} — ${sel.subject.name} — ${termLabel(sel.term)}</strong>. ` +
          'This class, subject and term is now locked; contact an administrator if a correction is needed.'
      );
      return res.redirect(`/teacher/marks/view/${submission.id}`);
    } catch (err) {
      if (err.code === 'DUPLICATE') {
        // Someone submitted the same combination in the meantime — the DB
        // unique index caught it, so re-render as the locked view.
        req.flash('error', err.message);
        return res.redirect(
          `/teacher/marks/entry?year=${sel.yearId}&class=${sel.classId}&subject=${sel.subjectId}&term=${sel.term}`
        );
      }
      throw err;
    }
  } catch (err) {
    return next(err);
  }
});

/* -------------------------------------------------------------- my views -- */

router.get('/view', async (req, res, next) => {
  try {
    const ctx = await selectionContext();
    const submissions = await marksService.listSubmissions({
      teacherId: req.session.user.teacherId,
      yearId: req.query.year || undefined,
      classId: req.query.class || undefined,
      subjectId: req.query.subject || undefined,
      term: req.query.term || undefined,
    });

    return res.render('teacher/marks-list', {
      title: 'My Submissions',
      wide: true,
      ...ctx,
      submissions,
      filters: {
        year: req.query.year || '',
        class: req.query.class || '',
        subject: req.query.subject || '',
        term: req.query.term || '',
      },
    });
  } catch (err) {
    return next(err);
  }
});

/** A teacher may open any submission for the school, but only edit none of them. */
async function loadOrFail(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    req.flash('error', 'Unknown submission.');
    res.redirect('/teacher/marks/view');
    return null;
  }
  const data = await marksService.loadReport(id);
  if (!data) {
    req.flash('error', 'That submission no longer exists.');
    res.redirect('/teacher/marks/view');
    return null;
  }
  return data;
}

router.get('/view/:id(\\d+)', async (req, res, next) => {
  try {
    const data = await loadOrFail(req, res);
    if (!data) return undefined;

    return res.render('teacher/marks-detail', {
      title: 'Submitted Marks',
      wide: true,
      data,
      isMine: data.submission.teacher_id === req.session.user.teacherId,
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/view/:id(\\d+)/excel', async (req, res, next) => {
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

router.get('/view/:id(\\d+)/pdf', async (req, res, next) => {
  try {
    const data = await loadOrFail(req, res);
    if (!data) return undefined;
    return reports.streamPdf(data, { schoolName: res.locals.schoolName, res });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
