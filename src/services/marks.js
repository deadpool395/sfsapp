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
  adm.username   AS updated_by_admin`;

const SUBMISSION_JOINS = `
  FROM mark_submissions s
  JOIN academic_years ay ON ay.id = s.academic_year_id
  JOIN classes        c  ON c.id  = s.class_id
  JOIN subjects       subj ON subj.id = s.subject_id
  JOIN teachers       t  ON t.id  = s.teacher_id
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

  const add = (sql, value) => {
    if (value === undefined || value === null || value === '') return;
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };

  add('s.academic_year_id = ?', filters.yearId);
  add('s.class_id = ?', filters.classId);
  add('s.subject_id = ?', filters.subjectId);
  add('s.term = ?', filters.term);
  add('s.teacher_id = ?', filters.teacherId);

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

/**
 * Create a submission and its marks in one transaction.
 *
 * Throws an error tagged `code: 'DUPLICATE'` when a submission already exists
 * for the same year/class/subject/term — the database unique index is what
 * actually enforces this, so a replayed POST cannot slip past the UI check.
 */
async function createSubmission({ yearId, classId, subjectId, term, teacherId, unitTestMax, secondaryMax, secondaryComponent, rows, actor }) {
  return db.transaction(async (c) => {
    let submission;
    try {
      const res = await c.query(
        `INSERT INTO mark_submissions
           (academic_year_id, class_id, subject_id, term, teacher_id,
            unit_test_max, secondary_max, secondary_component)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [yearId, classId, subjectId, term, teacherId, unitTestMax, secondaryMax, secondaryComponent]
      );
      submission = res.rows[0];
    } catch (err) {
      if (err.code === UNIQUE_VIOLATION) {
        const dup = new Error('Marks have already been submitted for this class, subject and term.');
        dup.code = 'DUPLICATE';
        throw dup;
      }
      throw err;
    }

    if (rows.length) {
      await c.query(
        `INSERT INTO marks (submission_id, student_id, unit_test_mark, secondary_mark)
         SELECT $1, s, u, a
           FROM unnest($2::int[], $3::numeric[], $4::numeric[]) AS t(s, u, a)`,
        [
          submission.id,
          rows.map((r) => r.studentId),
          rows.map((r) => r.unitTest),
          rows.map((r) => r.secondary),
        ]
      );
    }

    await audit.log(
      {
        actor,
        action: 'submission.create',
        entity: 'mark_submission',
        entityId: submission.id,
        details: { students: rows.length, term, subjectId, classId },
      },
      c
    );

    return submission;
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
  const unitMax = Number(submission.unit_test_max);
  const secMax = Number(submission.secondary_max);
  const totalMax = unitMax + secMax;

  const students = markRows.map((r, i) => {
    const ut = numOrNull(r.unit_test_mark);
    const sec = numOrNull(r.secondary_mark);
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
  createSubmission,
  updateMarks,
  releaseSubmission,
  buildReportData,
  loadReport,
  numOrNull,
};
