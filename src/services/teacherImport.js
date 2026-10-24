'use strict';
/**
 * Bulk import of teaching staff from a spreadsheet.
 *
 * Shares the parse / stage / map pipeline with services/excelImport.js and adds
 * only what is teacher-shaped. Teachers are not scoped to an academic year, so
 * this is considerably simpler than the student import.
 */

const db = require('../db/pool');
const audit = require('../lib/audit');
const { normalise, projectRow } = require('./excelImport');

/* ------------------------------------------------------------ target fields */

const FIELDS = [
  { key: 'name', label: 'Teacher Name', required: true },
  { key: 'employee_code', label: 'Staff Code', hint: 'Used to match existing staff' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
];

const FIELD_KEYS = new Set(FIELDS.map((f) => f.key));

/** Header synonyms, matched after normalising to lowercase alphanumerics. */
const SYNONYMS = {
  name: ['name', 'teacher', 'teachername', 'staffname', 'fullname', 'nameofteacher', 'teachersname'],
  employee_code: ['staffcode', 'employeecode', 'empcode', 'staffid', 'employeeid', 'code', 'empid'],
  email: ['email', 'emailid', 'mailid', 'mail', 'emailaddress'],
  phone: ['phone', 'phoneno', 'phonenumber', 'mobile', 'mobileno', 'contact', 'contactno', 'contactnumber'],
};

/** Suggest a target field for each column heading. */
function suggestMapping(columns) {
  const used = new Set();
  const mapping = {};

  columns.forEach((heading, i) => {
    const n = normalise(heading);
    if (!n) return;
    for (const key of Object.keys(SYNONYMS)) {
      if (used.has(key)) continue;
      if (SYNONYMS[key].includes(n)) {
        mapping[i] = key;
        used.add(key);
        break;
      }
    }
  });

  return mapping;
}

/* -------------------------------------------------------------- existing -- */

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

/**
 * Existing staff indexed for matching: by staff code first, then by name.
 * Loaded in one query — the app runs against a hosted database where a
 * per-row lookup would cost hundreds of milliseconds each.
 */
async function loadExisting(runner = db) {
  const rows = await runner.many(
    'SELECT id, name, employee_code, email, phone, is_active FROM teachers'
  );
  const byCode = new Map();
  const byName = new Map();
  for (const t of rows) {
    if (t.employee_code) byCode.set(clean(t.employee_code).toLowerCase(), t);
    byName.set(clean(t.name).toLowerCase(), t);
  }
  return { rows, byCode, byName };
}

/** Staff code wins over name, since it is the stable identifier. */
function matchTeacher(index, row) {
  const code = clean(row.employee_code).toLowerCase();
  if (code && index.byCode.has(code)) return index.byCode.get(code);
  const name = clean(row.name).toLowerCase();
  if (name && index.byName.has(name)) return index.byName.get(name);
  return null;
}

/* --------------------------------------------------------------- preview -- */

/** The key a row is de-duplicated on within a single file. */
function dedupeKey(entry) {
  return (entry.employee_code || entry.name).toLowerCase();
}

/**
 * Decide what one row will do. `seen` carries the keys already consumed by
 * earlier rows, so a name repeated inside the file is reported as skipped here
 * exactly as commitImport will treat it — the preview has to match reality.
 */
function classifyRow(index, entry, seen) {
  if (!entry.name) return { action: 'skip', reason: 'no name', match: null };

  const key = dedupeKey(entry);
  if (seen.has(key)) return { action: 'skip', reason: 'duplicate in file', match: null };
  seen.add(key);

  const match = matchTeacher(index, entry);
  return { action: match ? 'update' : 'add', reason: null, match };
}

function projectTeacher(row, mapping) {
  const p = projectRow(row, mapping);
  return {
    name: clean(p.name),
    employee_code: clean(p.employee_code),
    email: clean(p.email),
    phone: clean(p.phone),
  };
}

/** First rows projected through the mapping, flagged against existing staff. */
async function buildPreview({ rows, mapping, limit = 10 }) {
  const index = await loadExisting();
  const seen = new Set();

  // Walk every row so the `seen` set is accurate, but only return the first few.
  return rows
    .map((row) => {
      const entry = projectTeacher(row, mapping);
      const { action, reason, match } = classifyRow(index, entry, seen);
      return { ...entry, action, reason, match: match ? match.name : null, willSkip: action === 'skip' };
    })
    .slice(0, limit);
}

/** What the whole file will do, and how many staff already exist. */
async function importPlan({ rows, mapping }) {
  const index = await loadExisting();
  const seen = new Set();
  let add = 0;
  let update = 0;
  let skip = 0;

  for (const row of rows) {
    const { action } = classifyRow(index, projectTeacher(row, mapping), seen);
    if (action === 'add') add += 1;
    else if (action === 'update') update += 1;
    else skip += 1;
  }

  return { add, update, skip, existing: index.rows.length };
}

/* ---------------------------------------------------------------- commit -- */

/**
 * Write the mapped rows into `teachers` in one transaction.
 *
 * Matching is by staff code, then by name. A blank cell never overwrites a
 * stored value — an upload that omits phone numbers must not erase the ones
 * already on file.
 */
async function commitImport({ parsed, mapping, options = {}, actor, filename }) {
  const { rows } = parsed;
  const deactivateMissing = options.deactivateMissing === true;

  const stats = { total: rows.length, inserted: 0, updated: 0, skipped: 0, deactivated: 0 };
  const errors = [];
  const deactivatedNames = [];

  await db.transaction(async (c) => {
    const client = { many: async (sql, params) => (await c.query(sql, params)).rows };
    const index = await loadExisting(client);

    const seenIds = new Set();
    const toInsert = [];
    // Same classifier the preview used, so the two cannot disagree.
    const seen = new Set();

    for (let i = 0; i < rows.length; i += 1) {
      const rowNo = i + 2; // +1 for zero-index, +1 for the header row
      const raw = projectTeacher(rows[i], mapping);
      const { action, reason, match } = classifyRow(index, raw, seen);

      if (action === 'skip') {
        stats.skipped += 1;
        if (errors.length < 100) {
          errors.push({
            row: rowNo,
            message: reason === 'no name'
              ? 'No teacher name — row skipped.'
              : `${raw.name}: appears more than once in this file — later row skipped.`,
          });
        }
        continue;
      }

      // Blank cells become NULL so COALESCE below leaves stored values alone.
      const entry = {
        name: raw.name,
        employee_code: raw.employee_code || null,
        email: raw.email || null,
        phone: raw.phone || null,
      };

      try {
        if (match) {
          // COALESCE keeps whatever is already stored when the cell is blank.
          await c.query(
            `UPDATE teachers
                SET name          = $1,
                    employee_code = COALESCE($2, employee_code),
                    email         = COALESCE($3, email),
                    phone         = COALESCE($4, phone),
                    is_active     = TRUE
              WHERE id = $5`,
            [entry.name, entry.employee_code, entry.email, entry.phone, match.id]
          );
          seenIds.add(match.id);
          stats.updated += 1;
        } else {
          toInsert.push(entry);
        }
      } catch (err) {
        stats.skipped += 1;
        if (errors.length < 100) errors.push({ row: rowNo, message: `${entry.name}: ${err.message}` });
      }
    }

    // One multi-row insert rather than a round trip per new teacher.
    if (toInsert.length) {
      const inserted = await c.query(
        `INSERT INTO teachers (name, employee_code, email, phone)
         SELECT n, c, e, p
           FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS t(n, c, e, p)
         RETURNING id`,
        [
          toInsert.map((t) => t.name),
          toInsert.map((t) => t.employee_code),
          toInsert.map((t) => t.email),
          toInsert.map((t) => t.phone),
        ]
      );
      for (const r of inserted.rows) seenIds.add(r.id);
      stats.inserted = inserted.rowCount;
    }

    /* ----------------------------------------- retire staff not in the file */
    if (deactivateMissing) {
      // Deactivate, never delete: mark_submissions references teachers with
      // ON DELETE RESTRICT, and the mark history must keep its attribution.
      const ids = [...seenIds];
      const res = await c.query(
        `UPDATE teachers SET is_active = FALSE
          WHERE is_active AND NOT (id = ANY($1::int[]))
        RETURNING name`,
        [ids.length ? ids : [0]]
      );
      stats.deactivated = res.rowCount;
      deactivatedNames.push(...res.rows.map((r) => r.name));
    }

    await audit.log(
      {
        actor,
        action: 'teachers.import',
        entity: 'teachers',
        details: {
          filename: filename || null,
          ...stats,
          deactivated_names: deactivatedNames,
        },
      },
      c
    );
  });

  return { stats, errors, deactivatedNames };
}

module.exports = {
  FIELDS,
  FIELD_KEYS,
  suggestMapping,
  buildPreview,
  importPlan,
  commitImport,
};
