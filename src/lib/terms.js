'use strict';
/** The three terms, and labels for the second assessed component. */

const TERMS = [
  { value: 'term1', label: 'Term 1' },
  { value: 'term2', label: 'Term 2' },
  { value: 'term3', label: 'Term 3' },
];

const TERM_LABELS = Object.fromEntries(TERMS.map((t) => [t.value, t.label]));

function isTerm(value) {
  return Object.prototype.hasOwnProperty.call(TERM_LABELS, value);
}

function termLabel(value) {
  return TERM_LABELS[value] ?? value ?? '';
}

/* ---------------------------------------------------------- components --- */

const SECONDARY_COMPONENTS = [
  { value: 'assignment', label: 'Assignment' },
  { value: 'practical', label: 'Practical' },
];

const COMPONENT_LABELS = Object.fromEntries(SECONDARY_COMPONENTS.map((c) => [c.value, c.label]));

function isSecondaryComponent(value) {
  return Object.prototype.hasOwnProperty.call(COMPONENT_LABELS, value);
}

/**
 * Human label for a subject's second component — "Assignment" for most
 * subjects, "Practical" for Computer and anything else an admin designates.
 */
function componentLabel(value) {
  return COMPONENT_LABELS[value] ?? 'Assignment';
}

/** Settings key holding the default maximum for a component. */
function componentMaxKey(value) {
  return value === 'practical' ? 'default_practical_max' : 'default_assignment_max';
}

module.exports = {
  TERMS,
  TERM_LABELS,
  isTerm,
  termLabel,
  SECONDARY_COMPONENTS,
  isSecondaryComponent,
  componentLabel,
  componentMaxKey,
};
