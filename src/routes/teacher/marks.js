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
const { parseComponentRows, rawValues } = require('../../lib/markInput');
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

/**
 * Everything the entry sheet needs to render a mixed open/locked state.
 *
 * A recorded column keeps the maximum it was recorded under; an open one takes
 * the current default from settings. Already-recorded marks are passed through
 * so the locked column can be shown read-only next to the one being entered.
 */
async function entryViewModel({ sel, existing, state }) {
  const roster = await marksService.getRoster(sel.classId);
  const secondaryComponent = existing ? existing.secondary_component : sel.subject.secondary_component;
  const defaults = await settingsStore.maxMarks();
  const defaultSecondaryMax = await settingsStore.secondaryMaxFor(secondaryComponent);

  const recorded = {};
  if (existing) {
    for (const m of await marksService.getSubmissionMarks(existing.id)) {
      recorded[m.student_id] = { unit_test: m.unit_test_mark, secondary: m.secondary_mark };
    }
  }

  const columns = [
    {
      key: 'unit_test',
      prefix: 'ut',
      label: 'Unit Test',
      open: state.unit_test.open,
      max: state.unit_test.recorded ? state.unit_test.max : defaults.unitTest,
      teacherName: state.unit_test.teacherName,
      submittedAt: state.unit_test.submittedAt,
    },
    {
      key: 'secondary',
      prefix: 'sec',
      label: componentLabel(secondaryComponent),
      open: state.secondary.open,
      max: state.secondary.recorded ? state.secondary.max : defaultSecondaryMax,
      teacherName: state.secondary.teacherName,
      submittedAt: state.secondary.submittedAt,
    },
  ];

  return { sel, roster, columns, state, recorded, secondaryComponent };
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

    const existing = await marksService.findSubmission(sel);
    const state = marksService.componentState(existing);

    // Only when BOTH components are closed is there nothing left to do here.
    if (existing && state.allRecorded) {
      const data = marksService.buildReportData(existing, await marksService.getSubmissionMarks(existing.id));
      return res.render('teacher/marks-locked', {
        title: 'Already submitted',
        wide: true,
        data,
        isMine:
          state.unit_test.teacherId === req.session.user.teacherId ||
          state.secondary.teacherId === req.session.user.teacherId,
      });
    }

    return res.render('teacher/marks-entry', {
      title: 'Enter Marks',
      wide: true,
      ...(await entryViewModel({ sel, existing, state })),
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

    const existing = await marksService.findSubmission(sel);
    const state = marksService.componentState(existing);
    const vm = await entryViewModel({ sel, existing, state });

    // A column is recorded only if the teacher ticked it, and only if it is
    // still open — so an unticked column is left untouched for another day.
    const attempted = vm.columns.filter((col) => req.body[`record_${col.key}`] === 'on');
    const ticked = attempted.filter((col) => col.open);
    const alreadyClosed = attempted.filter((col) => !col.open);

    const errors = [];
    const components = {};

    // Ticking a column that closed since the page was opened is a different
    // problem from ticking nothing, and deserves a different explanation.
    for (const col of alreadyClosed) {
      errors.push(
        `${col.label} has already been recorded for this class, subject and term` +
          `${col.teacherName ? ` by ${col.teacherName}` : ''}. ` +
          'Contact an administrator if it needs to change.'
      );
    }

    if (!ticked.length && !alreadyClosed.length) {
      errors.push(
        'Tick the column you are recording. Marks are only saved for a column you tick, ' +
          'so you can enter the other one another day.'
      );
    }

    for (const col of ticked) {
      // Maxima come from settings, never from the form.
      const parsed = parseComponentRows({
        body: req.body,
        roster: vm.roster,
        component: col.key,
        max: col.max,
        label: col.label,
      });
      errors.push(...parsed.errors);
      components[col.key] = { max: col.max, rows: parsed.rows };
    }

    if (errors.length) {
      return res.status(400).render('teacher/marks-entry', {
        title: 'Enter Marks',
        wide: true,
        ...vm,
        values: rawValues({ body: req.body, roster: vm.roster }),
        ticked: ticked.map((c) => c.key),
        errors,
      });
    }

    try {
      const submission = await marksService.recordComponents({
        yearId: sel.yearId,
        classId: sel.classId,
        subjectId: sel.subjectId,
        term: sel.term,
        teacherId: req.session.user.teacherId,
        secondaryComponent: vm.secondaryComponent,
        components,
        actor: req.session.user,
      });

      const names = ticked.map((c) => c.label).join(' and ');
      const after = marksService.componentState(submission);
      const stillOpen = marksService.COMPONENTS
        .filter((k) => after[k].open)
        .map((k) => vm.columns.find((c) => c.key === k).label);

      req.flash(
        'success',
        `<strong>${names}</strong> recorded for ${formatClassLabel(sel.cls)} — ${sel.subject.name} — ` +
          `${termLabel(sel.term)} and now locked. ` +
          (stillOpen.length
            ? `<strong>${stillOpen.join(' and ')}</strong> is still open — come back and enter it whenever you have the marks.`
            : 'Contact an administrator if a correction is needed.')
      );
      return res.redirect(`/teacher/marks/view/${submission.id}`);
    } catch (err) {
      if (err.code === 'COMPONENT_TAKEN') {
        // The database refused it: someone recorded that column first.
        const names = (err.components || [])
          .map((k) => vm.columns.find((c) => c.key === k)?.label || k)
          .join(' and ');
        req.flash('error', `${names} has already been recorded for this class, subject and term. Nothing was saved.`);
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
