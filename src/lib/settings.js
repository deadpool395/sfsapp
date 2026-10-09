'use strict';
/** Read/write access to the app_settings key-value table, with a short cache. */

const bcrypt = require('bcryptjs');
const db = require('../db/pool');

const CACHE_MS = 5000;
let cache = null;
let cachedAt = 0;

const DEFAULTS = {
  teacher_common_username: 'teacher',
  default_unit_test_max: '25',
  default_assignment_max: '10',
  default_practical_max: '20',
  school_name: 'St. Francis School',
};

async function all({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cachedAt < CACHE_MS) return cache;

  const rows = await db.many('SELECT key, value FROM app_settings');
  cache = { ...DEFAULTS };
  for (const row of rows) cache[row.key] = row.value;
  cachedAt = Date.now();
  return cache;
}

function invalidate() {
  cache = null;
  cachedAt = 0;
}

async function get(key) {
  const settings = await all();
  return settings[key];
}

async function set(key, value) {
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value == null ? null : String(value)]
  );
  invalidate();
}

/** The three default maxima, as numbers. */
async function maxMarks() {
  const s = await all();
  return {
    unitTest: Number(s.default_unit_test_max) || 25,
    assignment: Number(s.default_assignment_max) || 10,
    practical: Number(s.default_practical_max) || 20,
  };
}

/** Default maximum for a subject's second component. */
async function secondaryMaxFor(component) {
  const m = await maxMarks();
  return component === 'practical' ? m.practical : m.assignment;
}

/** Verify the shared teacher password. */
async function checkTeacherPassword(username, password) {
  const s = await all({ fresh: true });
  if (!s.teacher_common_password_hash) return false;
  if (String(username || '').trim().toLowerCase() !== String(s.teacher_common_username || '').toLowerCase()) {
    return false;
  }
  return bcrypt.compareSync(password || '', s.teacher_common_password_hash);
}

async function setTeacherPassword(password) {
  await set('teacher_common_password_hash', bcrypt.hashSync(password, 10));
}

module.exports = {
  all,
  get,
  set,
  invalidate,
  maxMarks,
  secondaryMaxFor,
  checkTeacherPassword,
  setTeacherPassword,
};
