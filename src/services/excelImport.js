'use strict';
/**
 * Student Excel import: parse -> suggest a column mapping -> preview -> commit.
 *
 * The school's own sheet is `SNo | Name | Admission Number | Class`, where
 * Class combines class and division ("LKG A", "XI Science"). The mapping step
 * keeps the importer working if that layout ever changes.
 */

const crypto = require('crypto');
const ExcelJS = require('exceljs');

const db = require('../db/pool');
const { parseClassLabel, classSortOrder, formatClassLabel } = require('../lib/classes');

/* ------------------------------------------------------------ target fields */

const FIELDS = [
  { key: 'full_name',     label: 'Student Name',            required: true },
  { key: 'admission_no',  label: 'Admission Number',        hint: 'Used to match existing students' },
  { key: 'class_label',   label: 'Class + Division (combined)', hint: 'e.g. "LKG A" or "XI Science"' },
  { key: 'class_name',    label: 'Class only',              hint: 'e.g. "LKG" — use with Division' },
  { key: 'division',      label: 'Division only',           hint: 'e.g. "A"' },
  { key: 'roll_no',       label: 'Roll Number' },
  { key: 'gender',        label: 'Gender' },
  { key: 'dob',           label: 'Date of Birth' },
  { key: 'guardian_name', label: 'Guardian Name' },
  { key: 'contact',       label: 'Contact Number' },
];

const FIELD_KEYS = new Set(FIELDS.map((f) => f.key));

/** Header synonyms, matched after normalising to lowercase alphanumerics. */
const SYNONYMS = {
  full_name: ['name', 'studentname', 'nameofstudent', 'student', 'studentsname', 'fullname', 'namesofstudents'],
  admission_no: ['admissionnumber', 'admissionno', 'admno', 'admnumber', 'admission', 'regno', 'registerno', 'registernumber'],
  class_like: ['class', 'std', 'standard', 'grade', 'classdivision', 'classanddivision', 'classdiv'],
  division: ['division', 'div', 'section', 'sec', 'batch', 'stream'],
  roll_no: ['rollno', 'roll', 'rollnumber', 'classrollno'],
  gender: ['gender', 'sex'],
  dob: ['dob', 'dateofbirth', 'birthdate', 'birthday'],
  guardian_name: ['guardianname', 'guardian', 'fathersname', 'fathername', 'mothersname', 'mothername', 'parentname'],
  contact: ['contact', 'contactno', 'contactnumber', 'phone', 'phoneno', 'mobile', 'mobileno', 'phonenumber'],
};

function normalise(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/* ------------------------------------------------------------------- parse */

/** Flatten an exceljs cell to a plain string. */
function cellText(cell) {
  const v = cell?.value;
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
    if (v.text !== undefined) return String(v.text);
    if (v.result !== undefined) return String(v.result);
    if (v.hyperlink && v.text) return String(v.text);
    return '';
  }
  return String(v);
}

/** Read the first worksheet into a header row plus data rows. */
async function parseWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);

  const ws = wb.worksheets.find((s) => s.rowCount > 0) || wb.worksheets[0];
  if (!ws) throw Object.assign(new Error('That file contains no worksheets.'), { status: 400 });

  const matrix = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells = [];
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      cells[col - 1] = cellText(cell).trim();
    });
    if (cells.some((c) => c !== '')) matrix.push(cells);
  });

  if (!matrix.length) throw Object.assign(new Error('That sheet has no rows.'), { status: 400 });

  // Header = first row with at least three populated cells.
  let headerIdx = matrix.findIndex((r) => r.filter((c) => c !== '').length >= 3);
  if (headerIdx === -1) headerIdx = 0;

  const header = matrix[headerIdx];
  const width = Math.max(...matrix.map((r) => r.length));
  const columns = [];
  for (let i = 0; i < width; i++) columns.push(header[i] || '');

  const rows = matrix
    .slice(headerIdx + 1)
    .map((r) => {
      const padded = [];
      for (let i = 0; i < width; i++) padded[i] = r[i] ?? '';
      return padded;
    })
    .filter((r) => r.some((c) => c !== ''));

  return { sheetName: ws.name, columns, rows };
}

/**
 * Suggest a target field for each column.
 *
 * A class-ish header maps to the combined `class_label` unless the sheet also
 * has a separate division column, in which case it maps to `class_name`.
 */
function suggestMapping(columns) {
  const norms = columns.map(normalise);
  const hasDivision = norms.some((n) => n && SYNONYMS.division.includes(n));
  const used = new Set();
  const mapping = {};

  columns.forEach((_, i) => {
    const n = norms[i];
    if (!n) return;

    let field = null;
    if (SYNONYMS.class_like.includes(n)) {
      field = hasDivision ? 'class_name' : 'class_label';
    } else if (SYNONYMS.division.includes(n)) {
      field = 'division';
    } else {
      for (const key of ['admission_no', 'roll_no', 'full_name', 'gender', 'dob', 'guardian_name', 'contact']) {
        if (SYNONYMS[key].includes(n)) { field = key; break; }
      }
    }

    // Each target may be used once; the first matching column wins.
    if (field && !used.has(field)) {
      mapping[i] = field;
      used.add(field);
    }
  });

  return mapping;
}

/** Keep only valid, non-duplicated field assignments from posted form data. */
function sanitiseMapping(raw, columnCount) {
  const mapping = {};
  const used = new Set();
  for (let i = 0; i < columnCount; i++) {
    const field = raw[`col_${i}`];
    if (!field || !FIELD_KEYS.has(field) || used.has(field)) continue;
    mapping[i] = field;
    used.add(field);
  }
  return mapping;
}

/* ---------------------------------------------------------------- staging */

/**
 * Parsed uploads waiting for the admin to confirm their mapping. Held in
 * memory rather than in the session so a 2,000-row sheet does not get written
 * into the session store on every request.
 */
const staging = new Map();
const STAGE_TTL_MS = 30 * 60 * 1000;

function stash(payload) {
  const token = crypto.randomBytes(16).toString('hex');
  staging.set(token, { ...payload, createdAt: Date.now() });
  sweep();
  return token;
}

function peek(token) {
  const entry = staging.get(token);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > STAGE_TTL_MS) {
    staging.delete(token);
    return null;
  }
  return entry;
}

function discard(token) {
  staging.delete(token);
}

function sweep() {
  const cutoff = Date.now() - STAGE_TTL_MS;
  for (const [token, entry] of staging) {
    if (entry.createdAt < cutoff) staging.delete(token);
  }
}

/* ------------------------------------------------------------- row mapping */

/** Turn a raw sheet row into field values using the mapping. */
function projectRow(row, mapping) {
  const out = { extra: {} };
  for (const [index, field] of Object.entries(mapping)) {
    out[field] = String(row[index] ?? '').trim();
  }
  return out;
}

function unmappedExtras(row, mapping, columns) {
  const extra = {};
  for (let i = 0; i < columns.length; i++) {
    if (mapping[i]) continue;
    const value = String(row[i] ?? '').trim();
    if (!value) continue;
    const key = columns[i] || `column_${i + 1}`;
    extra[key] = value;
  }
  return extra;
}

/** Resolve the class label for a row from whichever columns were mapped. */
function rowClassLabel(projected) {
  if (projected.class_label) return projected.class_label;
  if (projected.class_name) {
    return projected.division ? `${projected.class_name} ${projected.division}` : projected.class_name;
  }
  return '';
}

const DATE_PATTERNS = [
  /^(\d{4})-(\d{1,2})-(\d{1,2})$/,          // 2015-04-09
  /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/,    // 09/04/2015 (d/m/y)
];

function parseDob(text) {
  const s = String(text || '').trim();
  if (!s) return null;

  let m = DATE_PATTERNS[0].exec(s);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;

  m = DATE_PATTERNS[1].exec(s);
  if (m) return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;

  // Excel serial date.
  const n = Number(s);
  if (Number.isFinite(n) && n > 20000 && n < 60000) {
    return new Date(Math.round((n - 25569) * 86400 * 1000)).toISOString().slice(0, 10);
  }
  return null;
}

/* -------------------------------------------------------------- preview */

/** First `limit` rows projected through the mapping, for the preview table. */
function buildPreview({ columns, rows, mapping, limit = 10 }) {
  return rows.slice(0, limit).map((row) => {
    const p = projectRow(row, mapping);
    const label = rowClassLabel(p);
    const parsed = parseClassLabel(label);
    return {
      full_name: p.full_name || '',
      admission_no: p.admission_no || '',
      class_label: label,
      class_name: parsed.name,
      division: parsed.division,
      roll_no: p.roll_no || '',
      gender: p.gender || '',
      dob: p.dob ? parseDob(p.dob) || p.dob : '',
      extra: unmappedExtras(row, mapping, columns),
    };
  });
}

/** Distinct class labels in the sheet, flagged against existing classes. */
async function classPlan({ rows, mapping, yearId }) {
  const counts = new Map();
  for (const row of rows) {
    const label = rowClassLabel(projectRow(row, mapping));
    const parsed = parseClassLabel(label);
    const key = formatClassLabel(parsed);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const existing = await db.many(
    'SELECT id, name, division FROM classes WHERE academic_year_id = $1',
    [yearId]
  );
  const existingLabels = new Set(existing.map((c) => formatClassLabel(c)));

  return [...counts.entries()]
    .map(([label, count]) => ({ label, count, exists: existingLabels.has(label) }))
    .sort((a, b) => {
      const pa = parseClassLabel(a.label);
      const pb = parseClassLabel(b.label);
      return classSortOrder(pa.name) - classSortOrder(pb.name) || a.label.localeCompare(b.label);
    });
}

/* --------------------------------------------------------------- commit */

/**
 * Write the mapped rows into `students` in one transaction.
 *
 * Matching is by (academic_year_id, admission_no) — the school's admission
 * numbers are unique and always present, and names are not unique, so names
 * are never used as the key when an admission number exists.
 */
async function commitImport({ yearId, parsed, mapping, options = {}, actor, filename }) {
  const { columns, rows, sheetName } = parsed;
  const createMissingClasses = options.createMissingClasses !== false;
  const deactivateMissing = options.deactivateMissing === true;

  const stats = { total: rows.length, inserted: 0, updated: 0, skipped: 0, classesCreated: 0, deactivated: 0 };
  const errors = [];
  const seenStudentIds = [];

  await db.transaction(async (c) => {
    /* class cache ------------------------------------------------------- */
    const classCache = new Map();
    const existing = await c.query(
      'SELECT id, name, division FROM classes WHERE academic_year_id = $1',
      [yearId]
    );
    for (const row of existing.rows) classCache.set(formatClassLabel(row), row.id);

    async function resolveClassId(label, rowNo) {
      const parsedLabel = parseClassLabel(label);
      const key = formatClassLabel(parsedLabel);
      if (!key) return null;
      if (classCache.has(key)) return classCache.get(key);
      if (!createMissingClasses) {
        errors.push({ row: rowNo, message: `Class "${key}" does not exist and creating classes was not allowed.` });
        return undefined; // signals "skip this row"
      }

      const created = await c.query(
        `INSERT INTO classes (academic_year_id, name, division, sort_order)
              VALUES ($1, $2, $3, $4)
         ON CONFLICT (academic_year_id, name, division)
         DO UPDATE SET name = EXCLUDED.name
           RETURNING id`,
        [yearId, parsedLabel.name, parsedLabel.division, classSortOrder(parsedLabel.name)]
      );
      classCache.set(key, created.rows[0].id);
      stats.classesCreated += 1;
      return created.rows[0].id;
    }

    /* rows -------------------------------------------------------------- */
    for (let i = 0; i < rows.length; i++) {
      const rowNo = i + 2; // +1 for zero-index, +1 for the header row
      const p = projectRow(rows[i], mapping);
      const fullName = (p.full_name || '').replace(/\s+/g, ' ').trim();

      if (!fullName) {
        stats.skipped += 1;
        if (errors.length < 100) errors.push({ row: rowNo, message: 'No student name — row skipped.' });
        continue;
      }

      const classId = await resolveClassId(rowClassLabel(p), rowNo);
      if (classId === undefined) {
        stats.skipped += 1;
        continue;
      }

      const admissionNo = (p.admission_no || '').trim();
      const extra = unmappedExtras(rows[i], mapping, columns);
      const values = [
        yearId,
        classId,
        admissionNo || null,
        (p.roll_no || '').trim() || null,
        fullName,
        (p.gender || '').trim() || null,
        p.dob ? parseDob(p.dob) : null,
        (p.guardian_name || '').trim() || null,
        (p.contact || '').trim() || null,
        JSON.stringify(extra),
      ];

      try {
        if (admissionNo) {
          const res = await c.query(
            `INSERT INTO students
               (academic_year_id, class_id, admission_no, roll_no, full_name,
                gender, dob, guardian_name, contact, extra)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (academic_year_id, admission_no)
               WHERE admission_no IS NOT NULL AND admission_no <> ''
             DO UPDATE SET
               class_id      = EXCLUDED.class_id,
               roll_no       = COALESCE(EXCLUDED.roll_no, students.roll_no),
               full_name     = EXCLUDED.full_name,
               gender        = COALESCE(EXCLUDED.gender, students.gender),
               dob           = COALESCE(EXCLUDED.dob, students.dob),
               guardian_name = COALESCE(EXCLUDED.guardian_name, students.guardian_name),
               contact       = COALESCE(EXCLUDED.contact, students.contact),
               extra         = students.extra || EXCLUDED.extra,
               is_active     = TRUE,
               updated_at    = now()
             RETURNING id, (xmax = 0) AS inserted`,
            values
          );
          const row = res.rows[0];
          seenStudentIds.push(row.id);
          if (row.inserted) stats.inserted += 1;
          else stats.updated += 1;
        } else {
          // No admission number: fall back to name + class within the year.
          const found = await c.query(
            `SELECT id FROM students
              WHERE academic_year_id = $1 AND class_id = $2 AND lower(full_name) = lower($3)
              LIMIT 1`,
            [yearId, classId, fullName]
          );

          if (found.rows.length) {
            await c.query(
              `UPDATE students
                  SET roll_no = COALESCE($1, roll_no), gender = COALESCE($2, gender),
                      dob = COALESCE($3, dob), guardian_name = COALESCE($4, guardian_name),
                      contact = COALESCE($5, contact), extra = extra || $6::jsonb,
                      is_active = TRUE, updated_at = now()
                WHERE id = $7`,
              [values[3], values[5], values[6], values[7], values[8], values[9], found.rows[0].id]
            );
            seenStudentIds.push(found.rows[0].id);
            stats.updated += 1;
          } else {
            const res = await c.query(
              `INSERT INTO students
                 (academic_year_id, class_id, admission_no, roll_no, full_name,
                  gender, dob, guardian_name, contact, extra)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
              values
            );
            seenStudentIds.push(res.rows[0].id);
            stats.inserted += 1;
          }
        }
      } catch (err) {
        stats.skipped += 1;
        if (errors.length < 100) errors.push({ row: rowNo, message: `${fullName}: ${err.message}` });
      }
    }

    /* optionally retire students absent from the sheet ------------------ */
    if (deactivateMissing && seenStudentIds.length) {
      const res = await c.query(
        `UPDATE students SET is_active = FALSE, updated_at = now()
          WHERE academic_year_id = $1 AND is_active AND NOT (id = ANY($2::int[]))`,
        [yearId, seenStudentIds]
      );
      stats.deactivated = res.rowCount;
    }

    await c.query(
      `INSERT INTO import_batches
         (academic_year_id, filename, sheet_name, row_count, inserted, updated, skipped, mapping, errors, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        yearId,
        filename || null,
        sheetName || null,
        stats.total,
        stats.inserted,
        stats.updated,
        stats.skipped,
        JSON.stringify(mapping),
        JSON.stringify(errors.slice(0, 50)),
        actor?.displayName || 'admin',
      ]
    );
  });

  return { stats, errors };
}

module.exports = {
  FIELDS,
  parseWorkbook,
  suggestMapping,
  sanitiseMapping,
  buildPreview,
  classPlan,
  commitImport,
  stash,
  peek,
  discard,
  parseDob,
};
