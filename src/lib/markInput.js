'use strict';
/** Server-side parsing and validation of a submitted mark grid. */

/**
 * Parse one mark cell.
 * Blank means "absent / not assessed" and is stored as NULL, which is
 * deliberately different from a zero.
 */
function parseCell(raw, max, label, studentName, errors) {
  const text = String(raw ?? '').trim();
  if (text === '') return null;

  const value = Number(text);
  if (!Number.isFinite(value)) {
    errors.push(`${studentName}: ${label} "${text}" is not a number.`);
    return null;
  }
  if (value < 0) {
    errors.push(`${studentName}: ${label} cannot be negative.`);
    return null;
  }
  if (value > max) {
    errors.push(`${studentName}: ${label} is ${value} but the maximum is ${max}.`);
    return null;
  }
  // Two decimal places matches the NUMERIC(6,2) columns.
  return Math.round(value * 100) / 100;
}

/**
 * Read `ut_<id>` / `sec_<id>` fields for every student on the roster.
 *
 * Iterating the roster rather than the posted body means a tampered or partial
 * form cannot introduce marks for students who are not in the class.
 */
function parseMarkRows({ body, roster, unitMax, secMax, secondaryLabel }) {
  const errors = [];
  const rows = roster.map((student) => {
    const name = student.full_name;
    return {
      studentId: student.id,
      unitTest: parseCell(body[`ut_${student.id}`], unitMax, 'unit test mark', name, errors),
      secondary: parseCell(body[`sec_${student.id}`], secMax, `${secondaryLabel.toLowerCase()} mark`, name, errors),
    };
  });

  const entered = rows.filter((r) => r.unitTest !== null || r.secondary !== null).length;
  return { rows, errors, entered };
}

/** Echo back what the user typed so a rejected form keeps their input. */
function rawValues({ body, roster }) {
  const out = {};
  for (const student of roster) {
    out[student.id] = {
      unitTest: String(body[`ut_${student.id}`] ?? '').trim(),
      secondary: String(body[`sec_${student.id}`] ?? '').trim(),
    };
  }
  return out;
}

module.exports = { parseMarkRows, rawValues, parseCell };
