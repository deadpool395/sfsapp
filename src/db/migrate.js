'use strict';
/**
 * Apply schema.sql. Idempotent — every statement is CREATE ... IF NOT EXISTS.
 *
 *   node src/db/migrate.js          apply the schema
 *   node src/db/migrate.js --drop   drop every application table first
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { pool } = require('./pool');

// Reverse dependency order so the drops succeed without CASCADE surprises.
const TABLES = [
  'marks',
  'mark_submissions',
  'import_batches',
  'audit_log',
  'students',
  'classes',
  'subjects',
  'teachers',
  'academic_years',
  'admins',
  'app_settings',
  'session',
];

async function main() {
  const drop = process.argv.includes('--drop');

  if (drop) {
    console.log('Dropping existing tables…');
    await pool.query(`DROP TABLE IF EXISTS ${TABLES.map((t) => `"${t}"`).join(', ')} CASCADE`);
  }

  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('Schema applied.');

  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name`
  );
  console.log(`Tables (${rows.length}): ${rows.map((r) => r.table_name).join(', ')}`);
}

main()
  .catch((err) => {
    console.error('db:migrate failed —', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
