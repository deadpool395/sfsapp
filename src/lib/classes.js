'use strict';
/**
 * Class-label helpers.
 *
 * The uploaded student sheet stores class and division together in one cell:
 *   "LKG A", "I A", "X C"        -> division is a letter
 *   "XI Science", "XII Commerce" -> division is a stream
 * Splitting on the first run of whitespace handles both, because every class
 * name in the school's sheet is a single token.
 */

/** Display order for class names; anything unrecognised sorts to the end. */
const CLASS_SEQUENCE = [
  'LKG', 'UKG',
  'I', 'II', 'III', 'IV', 'V', 'VI',
  'VII', 'VIII', 'IX', 'X', 'XI', 'XII',
];

const SEQUENCE_INDEX = new Map(CLASS_SEQUENCE.map((n, i) => [n, i]));

/** Split a combined label such as "LKG A" into its parts. */
function parseClassLabel(label) {
  const cleaned = String(label ?? '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return { name: '', division: '' };

  const gap = cleaned.indexOf(' ');
  if (gap === -1) return { name: cleaned.toUpperCase(), division: '' };

  const name = cleaned.slice(0, gap).toUpperCase();
  const division = cleaned.slice(gap + 1).trim();

  // A single-letter division is conventionally upper case; a stream name
  // ("Science") keeps title case.
  return {
    name,
    division: division.length === 1 ? division.toUpperCase() : titleCase(division),
  };
}

function titleCase(s) {
  return s.replace(/\S+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

/** Render a class row back to "LKG A". */
function formatClassLabel(cls) {
  if (!cls) return '';
  const name = cls.name ?? '';
  const division = cls.division ?? '';
  return division ? `${name} ${division}` : name;
}

/** Position of a class name in CLASS_SEQUENCE, for the sort_order column. */
function classSortOrder(name) {
  const key = String(name ?? '').toUpperCase().trim();
  return SEQUENCE_INDEX.has(key) ? SEQUENCE_INDEX.get(key) : 999;
}

module.exports = {
  CLASS_SEQUENCE,
  parseClassLabel,
  formatClassLabel,
  classSortOrder,
};
