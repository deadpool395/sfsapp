'use strict';
/**
 * Seed baseline data: an admin account, the shared teacher credentials,
 * default maximum marks, the active academic year and a starter subject list.
 *
 * Idempotent — re-running updates nothing that already exists.
 */
require('dotenv').config();

const bcrypt = require('bcryptjs');
const { pool, transaction } = require('./pool');
const { classSortOrder } = require('../lib/classes');

const ADMIN_USERNAME = process.env.SEED_ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || 'admin123';
const TEACHER_USERNAME = process.env.SEED_TEACHER_USERNAME || 'teacher';
const TEACHER_PASSWORD = process.env.SEED_TEACHER_PASSWORD || 'sfs2026';

/** Computer is assessed on a practical, not an assignment. */
const SUBJECTS = [
  { name: 'English', secondary_component: 'assignment' },
  { name: 'Malayalam', secondary_component: 'assignment' },
  { name: 'Hindi', secondary_component: 'assignment' },
  { name: 'Mathematics', secondary_component: 'assignment' },
  { name: 'Environmental Science', secondary_component: 'assignment' },
  { name: 'Science', secondary_component: 'assignment' },
  { name: 'Physics', secondary_component: 'assignment' },
  { name: 'Chemistry', secondary_component: 'assignment' },
  { name: 'Biology', secondary_component: 'assignment' },
  { name: 'Social Science', secondary_component: 'assignment' },
  { name: 'Commerce', secondary_component: 'assignment' },
  { name: 'Computer', secondary_component: 'practical' },
  { name: 'General Knowledge', secondary_component: 'assignment' },
];

/** Sample teachers so the login dropdown is usable immediately. */
const SAMPLE_TEACHERS = [
  'Sr. Anitha Jose',
  'Mr. Rajesh Kumar',
  'Mrs. Lakshmi Nair',
  'Mr. Thomas Varghese',
  'Mrs. Deepa Menon',
];

async function main() {
  await transaction(async (c) => {
    /* ------------------------------------------------------------- admin -- */
    const hash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
    const admin = await c.query(
      `INSERT INTO admins (username, password_hash, full_name)
            VALUES ($1, $2, $3)
       ON CONFLICT (username) DO NOTHING
         RETURNING id`,
      [ADMIN_USERNAME, hash, 'School Administrator']
    );
    console.log(
      admin.rowCount
        ? `Created admin "${ADMIN_USERNAME}".`
        : `Admin "${ADMIN_USERNAME}" already exists (password left unchanged).`
    );

    /* ---------------------------------------------------------- settings -- */
    const settings = [
      ['teacher_common_username', TEACHER_USERNAME],
      ['teacher_common_password_hash', bcrypt.hashSync(TEACHER_PASSWORD, 10)],
      ['default_unit_test_max', '25'],
      ['default_assignment_max', '10'],
      ['default_practical_max', '20'],
      ['school_name', process.env.SCHOOL_NAME || 'St. Francis School'],
    ];
    for (const [key, value] of settings) {
      await c.query(
        `INSERT INTO app_settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO NOTHING`,
        [key, value]
      );
    }
    console.log('Settings ensured (shared teacher login, default maxima, school name).');

    /* ----------------------------------------------------- academic year -- */
    const year = await c.query(
      `INSERT INTO academic_years (name, start_date, end_date, is_active)
            VALUES ($1, $2, $3, TRUE)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id, name, is_active`,
      ['2026-2027', '2026-06-01', '2027-03-31']
    );
    const yearRow = year.rows[0];
    console.log(`Academic year "${yearRow.name}" ready (id ${yearRow.id}).`);

    /* ---------------------------------------------------------- subjects -- */
    for (const s of SUBJECTS) {
      await c.query(
        `INSERT INTO subjects (name, secondary_component) VALUES ($1, $2)
         ON CONFLICT (name) DO NOTHING`,
        [s.name, s.secondary_component]
      );
    }
    const subjectCount = await c.query('SELECT count(*)::int AS n FROM subjects');
    console.log(`Subjects: ${subjectCount.rows[0].n} (Computer set to practical).`);

    /* ---------------------------------------------------------- teachers -- */
    for (const name of SAMPLE_TEACHERS) {
      await c.query(
        `INSERT INTO teachers (name)
         SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM teachers WHERE name = $1)`,
        [name]
      );
    }
    const teacherCount = await c.query('SELECT count(*)::int AS n FROM teachers');
    console.log(`Teachers: ${teacherCount.rows[0].n} (samples — replace with the real staff list).`);

    /* ------------------------------------------------- backfill sort order */
    // Keeps LKG < UKG < I < … < XII for any classes created before this ran.
    const classes = await c.query('SELECT id, name FROM classes');
    for (const row of classes.rows) {
      await c.query('UPDATE classes SET sort_order = $1 WHERE id = $2', [
        classSortOrder(row.name),
        row.id,
      ]);
    }
  });

  console.log('\n--- Sign in -------------------------------------------------');
  console.log(`  Admin     ${ADMIN_USERNAME} / ${ADMIN_PASSWORD}`);
  console.log(`  Teachers  ${TEACHER_USERNAME} / ${TEACHER_PASSWORD}   (shared by all teachers)`);
  console.log('  Change both in Admin -> Settings before real use.');
  console.log('-------------------------------------------------------------');
}

main()
  .catch((err) => {
    console.error('db:seed failed —', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
