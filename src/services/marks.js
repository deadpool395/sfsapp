'use strict';
/**
 * Shared queries for mark submissions.
 *
 * Both the teacher entry flow and the admin oversight screens go through here
 * so that on-screen tables, Excel exports and PDF exports can never disagree.
 */

const db = require('../db/pool');
const audit = require('../lib/audit');

/** Postgres unique-violation. Raised by the duplicate-submission guard. */
const UNIQUE_VIOLATION = '23505';

/**
 * Roll numbers are free text ("7", "07", "7A", or blank), so sort by the
 * numeric part when there is one and fall back to the name.
 */
const ROSTER_ORDER = `
  ORDER BY NULLIF(regexp_replace(COALESCE(st.roll_no, ''), '\\D', '', 'g'), '')::bigint NULLS LAST,
           st.full_name`;

/* ------------------------------------------------------------- reference -- */

function listYears() {
  return db.many('SELECT * FROM academic_years ORDER BY name DESC');
}

function activeYear() {
  return db.one('SELECT * FROM academic_years WHERE is_active LIMIT 1');
}

function listClasses(yearId) {
  return db.many(
    `SELECT * FROM classes WHERE academic_year_id = $1
      ORDER BY sort_order, name, division`,
    [yearId]
  );
}

function listSubjects({ activeOnly = true } = {}) {
  return db.many(
    `SELECT * FROM subjects ${activeOnly ? 'WHERE is_active' : ''}
      ORDER BY name`
  );
}

function getSubject(id) {
  return db.one('SELECT * FROM subjects WHERE id = $1', [id]);
}

function getClass(id) {
  return db.one(
    `SELECT c.*, ay.name AS year_name
       FROM classes c JOIN academic_years ay ON ay.id = c.academic_year_id
      WHERE c.id = $1`,
    [id]
  );
}

/** Active students of a class, in roster order. */
function getRoster(classId) {
  return db.many(
    `SELECT st.id, st.full_name, st.roll_no, st.admission_no
       FROM students st
      WHERE st.class_id = $1 AND st.is_active
      ${ROSTER_ORDER}`,
    [classId]
  );
}

/* ------------------------------------------------------------ submissions -- */

const SUBMISSION_COLUMNS = `
  s.*,
  ay.name        AS year_name,
  c.name         AS class_name,
  c.division     AS class_division,
  c.sort_order   AS class_sort_order,
  subj.name      AS subject_name,
  t.name         AS teacher_name,
  ut_t.name      AS unit_test_teacher_name,
  sec_t.name     AS secondary_teacher_name,
  adm.username   AS updated_by_admin`;

const SUBMISSION_JOINS = `
  FROM mark_submissions s
  JOIN academic_years ay ON ay.id = s.academic_year_id
  JOIN classes        c  ON c.id  = s.class_id
  JOIN subjects       subj ON subj.id = s.subject_id
  JOIN teachers       t  ON t.id  = s.teacher_id
  LEFT JOIN teachers  ut_t  ON ut_t.id  = s.unit_test_teacher_id
  LEFT JOIN teachers  sec_t ON sec_t.id = s.secondary_teacher_id
  LEFT JOIN admins    adm ON adm.id = s.updated_by_admin_id`;

/** The existing submission for a year/class/subject/term, if any. */
function findSubmission({ yearId, classId, subjectId, term }) {
  return db.one(
    `SELECT ${SUBMISSION_COLUMNS} ${SUBMISSION_JOINS}
      WHERE s.academic_year_id = $1 AND s.class_id = $2
        AND s.subject_id = $3 AND s.term = $4`,
    [yearId, classId, subjectId, term]
  );
}

function getSubmission(id) {
  return db.one(`SELECT ${SUBMISSION_COLUMNS} ${SUBMISSION_JOINS} WHERE s.id = $1`, [id]);
}

/** Mark rows of a submission joined to their students, in roster order. */
function getSubmissionMarks(submissionId) {
  return db.many(
    `SELECT m.id, m.student_id, m.unit_test_mark, m.secondary_mark, m.remarks,
            st.full_name, st.roll_no, st.admission_no
       FROM marks m
       JOIN students st ON st.id = m.student_id
      WHERE m.submission_id = $1
      ${ROSTER_ORDER}`,
    [submissionId]
  );
}

/**
 * Submission list with optional filters. `teacherId` scopes it to one
 * teacher's own submissions; the admin view passes filters instead.
 */
async function listSubmissions(filters = {}) {
  const where = [];
  const params = [];

  // Every `?` in the fragment binds to the same value, so a filter may
  // reference it more than once.
  const add = (sql, value) => {
    if (value === undefined || value === null || value === '') return;
    params.push(value);
    where.push(sql.split('?').join(`$${params.length}`));
  };

  add('s.academic_year_id = ?', filters.yearId);
  add('s.class_id = ?', filters.classId);
  add('s.subject_id = ?', filters.subjectId);
  add('s.term = ?', filters.term);
  // A teacher "owns" a submission if they recorded either component, not just
  // if they happened to create the row.
  add('(s.unit_test_teacher_id = ? OR s.secondary_teacher_id = ?)', filters.teacherId);

  const rows = await db.many(
    `SELECT ${SUBMISSION_COLUMNS},
            (SELECT count(*)::int FROM marks m WHERE m.submission_id = s.id) AS student_count
     ${SUBMISSION_JOINS}
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY s.submitted_at DESC`,
    params
  );
  return rows;
}

/* -------------------------------------------------------- component state -- */

/**
 * The two assessed components. `open` is the single definition of "still
 * accepting entry", derived from `<component>_submitted_at`; routes, views and
 * reports read this rather than re-deriving the rule.
 */
const COMPONENTS = ['unit_test', 'secondary'];

function componentState(submission) {
  if (!submission) {
    return {
      unit_test: { key: 'unit_test', open: true, recorded: false, max: null },
      secondary: { key: 'secondary', open: true, recorded: false, max: null },
      anyOpen: true,
      anyRecorded: false,
      allRecorded: false,
    };
  }

  const build = (key) => {
    const at = submission[`${key}_submitted_at`] ?? null;
    return {
      key,
      recorded: at !== null,
      open: at === null,
      max: submission[`${key}_max`] === null || submission[`${key}_max`] === undefined
        ? null
        : Number(submission[`${key}_max`]),
      submittedAt: at,
      teacherId: submission[`${key}_teacher_id`] ?? null,
      teacherName: submission[`${key}_teacher_name`] ?? null,
    };
  };

  const state = { unit_test: build('unit_test'), secondary: build('secondary') };
  state.anyOpen = state.unit_test.open || state.secondary.open;
  state.anyRecorded = state.unit_test.recorded || state.secondary.recorded;
  state.allRecorded = !state.anyOpen;
  return state;
}

/**
 * Record one or both components of a class/subject/term, in one transaction.
 *
 * `components` carries only what the teacher ticked, e.g.
 *   { secondary: { max: 10, rows: [{ studentId, value }] } }
 *
 * Repeat entry is blocked by the database, not by the page. Either this call
 * creates the row (so it owns the components it just closed), or the row
 * already existed and each component is closed by a conditional UPDATE guarded
 * on `<c>_submitted_at IS NULL` — a replayed POST matches no rows and is
 * rejected. Components left unticked keep their marks and stay open.
 *
 * Throws `code: 'COMPONENT_TAKEN'` listing components someone else closed first.
 */
async function recordComponents({
  yearId, classId, subjectId, term, teacherId, secondaryComponent, components, actor,
}) {
  const keys = COMPONENTS.filter((k) => components[k]);
  if (!keys.length) throw new Error('No components were selected for recording.');

  return db.transaction(async (c) => {
    // `RETURNING id` tells us whether we created the row. If we did, the
    // components named here were closed by this very statement.
    const created = await c.query(
      `INSERT INTO mark_submissions
         (academic_year_id, class_id, subject_id, term, teacher_id, secondary_component,
          ${keys.map((k) => `${k}_max, ${k}_teacher_id, ${k}_submitted_at`).join(', ')})
       VALUES ($1, $2, $3, $4, $5, $6,
          ${keys.map((_, i) => `$${7 + i * 2}, $${8 + i * 2}, now()`).join(', ')})
       ON CONFLICT (academic_year_id, class_id, subject_id, term) DO NOTHING
       RETURNING id`,
      [
        yearId, classId, subjectId, term, teacherId, secondaryComponent,
        ...keys.flatMap((k) => [components[k].max, teacherId]),
      ]
    );

    let submissionId = created.rows[0]?.id ?? null;

    if (!submissionId) {
      // The row already existed: close each ticked component only if it is
      // still open.
      const { rows: found } = await c.query(
        `SELECT id FROM mark_submissions
          WHERE academic_year_id = $1 AND class_id = $2 AND subject_id = $3 AND term = $4
          FOR UPDATE`,
        [yearId, classId, subjectId, term]
      );
      submissionId = found[0].id;

      const taken = [];
      for (const key of keys) {
        const res = await c.query(
          `UPDATE mark_submissions
              SET ${key}_max = $1, ${key}_teacher_id = $2, ${key}_submitted_at = now()
            WHERE id = $3 AND ${key}_submitted_at IS NULL`,
          [components[key].max, teacherId, submissionId]
        );
        if (res.rowCount === 0) taken.push(key);
      }

      if (taken.length) {
        const err = new Error('Those marks have already been recorded.');
        err.code = 'COMPONENT_TAKEN';
        err.components = taken;
        throw err;
      }
    }

    // Write only the ticked components' columns, leaving the other intact.
    for (const key of keys) {
      const rows = components[key].rows;
      if (!rows.length) continue;
      await c.query(
        `INSERT INTO marks (submission_id, student_id, ${key}_mark)
         SELECT $1, s, v FROM unnest($2::int[], $3::numeric[]) AS t(s, v)
         ON CONFLICT (submission_id, student_id)
         DO UPDATE SET ${key}_mark = EXCLUDED.${key}_mark`,
        [submissionId, rows.map((r) => r.studentId), rows.map((r) => r.value)]
      );
    }

    await audit.log(
      {
        actor,
        action: 'submission.record',
        entity: 'mark_submission',
        entityId: submissionId,
        details: {
          components: keys,
          students: Math.max(...keys.map((k) => components[k].rows.length)),
          term,
          subjectId,
          classId,
        },
      },
      c
    );

    const { rows: fresh } = await c.query('SELECT * FROM mark_submissions WHERE id = $1', [submissionId]);
    return fresh[0];
  });
}

/** Admin override of individual marks. Always audited. */
async function updateMarks({ submissionId, rows, actor, before }) {
  return db.transaction(async (c) => {
    for (const row of rows) {
      await c.query(
        `UPDATE marks SET unit_test_mark = $1, secondary_mark = $2
          WHERE submission_id = $3 AND student_id = $4`,
        [row.unitTest, row.secondary, submissionId, row.studentId]
      );
    }

    await c.query(
      `UPDATE mark_submissions
          SET updated_at = now(), updated_by_admin_id = $1
        WHERE id = $2`,
      [actor?.adminId ?? null, submissionId]
    );

    const changed = diffRows(before, rows);
    await audit.log(
      {
        actor,
        action: 'marks.update',
        entity: 'mark_submission',
        entityId: submissionId,
        details: { changed },
      },
      c
    );

    return changed.length;
  });
}

/** Only the cells that actually moved, for a readable audit entry. */
function diffRows(before, after) {
  const prev = new Map((before || []).map((r) => [Number(r.student_id), r]));
  const out = [];

  for (const row of after) {
    const old = prev.get(Number(row.studentId));
    if (!old) continue;
    const changes = {};
    if (!sameMark(old.unit_test_mark, row.unitTest)) {
      changes.unit_test = { from: numOrNull(old.unit_test_mark), to: row.unitTest };
    }
    if (!sameMark(old.secondary_mark, row.secondary)) {
      changes.secondary = { from: numOrNull(old.secondary_mark), to: row.secondary };
    }
    if (Object.keys(changes).length) {
      out.push({ student_id: row.studentId, student: old.full_name, ...changes });
    }
  }
  return out;
}

function numOrNull(v) {
  return v === null || v === undefined || v === '' ? null : Number(v);
}

function sameMark(a, b) {
  const x = numOrNull(a);
  const y = numOrNull(b);
  if (x === null && y === null) return true;
  if (x === null || y === null) return false;
  return Math.abs(x - y) < 1e-9;
}

/**
 * Reopen a single component, clearing its marks while leaving the other
 * component untouched. If nothing is left recorded, the row itself goes, since
 * an empty submission carries no information.
 *
 * Audited with the removed values, so a release is always recoverable from the
 * audit trail.
 */
async function releaseComponent({ submissionId, component, actor }) {
  if (!COMPONENTS.includes(component)) throw new Error(`Unknown component "${component}".`);

  return db.transaction(async (c) => {
    const { rows: subRows } = await c.query(
      'SELECT * FROM mark_submissions WHERE id = $1 FOR UPDATE',
      [submissionId]
    );
    if (!subRows.length) return { released: false };
    const submission = subRows[0];
    // Already open — nothing to do.
    if (!submission[`${component}_submitted_at`]) return { released: false };

    const { rows: markRows } = await c.query(
      `SELECT m.student_id, m.${component}_mark AS value, st.full_name
         FROM marks m JOIN students st ON st.id = m.student_id
        WHERE m.submission_id = $1 AND m.${component}_mark IS NOT NULL`,
      [submissionId]
    );

    await audit.log(
      {
        actor,
        action: 'submission.component.release',
        entity: 'mark_submission',
        entityId: submissionId,
        details: {
          component,
          max: submission[`${component}_max`],
          recorded_by: submission[`${component}_teacher_id`],
          marks: markRows,
        },
      },
      c
    );

    await c.query(`UPDATE marks SET ${component}_mark = NULL WHERE submission_id = $1`, [submissionId]);
    await c.query(
      `UPDATE mark_submissions
          SET ${component}_max = NULL, ${component}_teacher_id = NULL, ${component}_submitted_at = NULL
        WHERE id = $1`,
      [submissionId]
    );

    const other = component === 'unit_test' ? 'secondary' : 'unit_test';
    const submissionRemoved = !submission[`${other}_submitted_at`];
    if (submissionRemoved) {
      // Nothing recorded any more — drop the row (cascades to its marks).
      await c.query('DELETE FROM mark_submissions WHERE id = $1', [submissionId]);
    }

    return { released: true, submissionRemoved, cleared: markRows.length };
  });
}

/**
 * Delete a submission so the class/subject/term is open again and the teacher
 * can re-enter it. Audited, with the removed marks kept in the audit details.
 */
async function releaseSubmission({ submissionId, actor }) {
  return db.transaction(async (c) => {
    const { rows: subRows } = await c.query('SELECT * FROM mark_submissions WHERE id = $1', [submissionId]);
    if (!subRows.length) return false;

    const { rows: markRows } = await c.query(
      `SELECT m.student_id, m.unit_test_mark, m.secondary_mark, st.full_name
         FROM marks m JOIN students st ON st.id = m.student_id
        WHERE m.submission_id = $1`,
      [submissionId]
    );

    await audit.log(
      {
        actor,
        action: 'submission.release',
        entity: 'mark_submission',
        entityId: submissionId,
        details: { submission: subRows[0], marks: markRows },
      },
      c
    );

    await c.query('DELETE FROM mark_submissions WHERE id = $1', [submissionId]);
    return true;
  });
}

/* --------------------------------------------------------------- reports -- */

/**
 * Normalise a submission plus its marks into the shape used by the on-screen
 * table, the Excel sheet and the PDF.
 */
function buildReportData(submission, markRows) {
  const state = componentState(submission);

  // Only a recorded component contributes a maximum. A report pulled before
  // both components exist is then scored out of what has actually been
  // assessed, instead of out of a maximum nobody has marked yet.
  const unitMax = state.unit_test.max;
  const secMax = state.secondary.max;
  const totalMax = (state.unit_test.recorded ? unitMax : 0) + (state.secondary.recorded ? secMax : 0);

  const students = markRows.map((r, i) => {
    // A blank inside a recorded component means absent; a component that has
    // not been recorded at all is simply not yet known, which is different.
    const ut = state.unit_test.recorded ? numOrNull(r.unit_test_mark) : null;
    const sec = state.secondary.recorded ? numOrNull(r.secondary_mark) : null;
    const hasAny = ut !== null || sec !== null;
    const total = hasAny ? (ut ?? 0) + (sec ?? 0) : null;
    return {
      index: i + 1,
      studentId: r.student_id,
      rollNo: r.roll_no || '',
      admissionNo: r.admission_no || '',
      name: r.full_name,
      unitTest: ut,
      secondary: sec,
      total,
      percent: total === null || totalMax === 0 ? null : (total / totalMax) * 100,
      absent: !hasAny,
    };
  });

  const scored = students.filter((s) => s.total !== null);
  const sum = (pick) => scored.reduce((acc, s) => acc + (pick(s) ?? 0), 0);

  return {
    submission,
    state,
    unitMax,
    secMax,
    totalMax,
    students,
    totals: {
      counted: scored.length,
      absent: students.length - scored.length,
      unitTest: scored.length ? sum((s) => s.unitTest) : null,
      secondary: scored.length ? sum((s) => s.secondary) : null,
      total: scored.length ? sum((s) => s.total) : null,
      averagePercent: scored.length ? sum((s) => s.percent) / scored.length : null,
    },
  };
}

/** Fetch a submission and return it as report-ready data. */
async function loadReport(submissionId) {
  const submission = await getSubmission(submissionId);
  if (!submission) return null;
  const markRows = await getSubmissionMarks(submissionId);
  return buildReportData(submission, markRows);
}

module.exports = {
  UNIQUE_VIOLATION,
  listYears,
  activeYear,
  listClasses,
  listSubjects,
  getSubject,
  getClass,
  getRoster,
  findSubmission,
  getSubmission,
  getSubmissionMarks,
  listSubmissions,
  COMPONENTS,
  componentState,
  recordComponents,
  updateMarks,
  releaseComponent,
  releaseSubmission,
  buildReportData,
  loadReport,
  numOrNull,
};
