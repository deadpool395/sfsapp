'use strict';
/**
 * Back the local database up to a remote Postgres (Render).
 *
 *   npm run db:backup            copy local -> BACKUP_DATABASE_URL
 *   npm run db:backup -- --dry   show what would happen, change nothing
 *   npm run db:backup -- --file  also keep the .sql dump under backups/
 *
 * The dump is taken with --clean --if-exists, so re-running replaces the
 * remote contents rather than duplicating rows.
 */
require('dotenv').config();

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const SOURCE = process.env.DATABASE_URL;
const TARGET = process.env.BACKUP_DATABASE_URL;

const dryRun = process.argv.includes('--dry');
const keepFile = process.argv.includes('--file');

/** Never print the password in logs. */
function redact(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '(unparseable url)';
  }
}

const TABLES = [
  'academic_years', 'classes', 'subjects', 'teachers', 'students',
  'admins', 'app_settings', 'mark_submissions', 'marks',
  'audit_log', 'import_batches',
];

async function counts(url, label) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const out = {};
    for (const t of TABLES) {
      try {
        const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${t}`);
        out[t] = rows[0].n;
      } catch {
        out[t] = null; // table absent
      }
    }
    const { rows: v } = await client.query('SHOW server_version');
    console.log(`${label}: PostgreSQL ${v[0].server_version}`);
    return out;
  } finally {
    await client.end();
  }
}

function printCounts(before, after) {
  const width = Math.max(...TABLES.map((t) => t.length));
  console.log(`\n  ${'table'.padEnd(width)}   local   remote`);
  console.log(`  ${'-'.repeat(width)}   -----   ------`);
  let ok = true;
  for (const t of TABLES) {
    const a = before[t];
    const b = after[t];
    const match = a === b;
    if (!match) ok = false;
    console.log(
      `  ${t.padEnd(width)} ${String(a ?? '-').padStart(7)} ${String(b ?? '-').padStart(8)}  ${match ? '' : '  <-- MISMATCH'}`
    );
  }
  return ok;
}

function which(exe) {
  const probe = spawnSync(exe, ['--version'], { encoding: 'utf8', shell: true });
  return probe.status === 0 ? probe.stdout.trim() : null;
}

async function main() {
  if (!SOURCE) throw new Error('DATABASE_URL is not set.');
  if (!TARGET) throw new Error('BACKUP_DATABASE_URL is not set — add the remote URL to .env.');

  const dumpVersion = which('pg_dump');
  const psqlVersion = which('psql');
  if (!dumpVersion) throw new Error('pg_dump not found on PATH.');
  if (!psqlVersion) throw new Error('psql not found on PATH.');

  console.log(`source : ${redact(SOURCE)}`);
  console.log(`target : ${redact(TARGET)}`);
  console.log(`tools  : ${dumpVersion} / ${psqlVersion}\n`);

  const before = await counts(SOURCE, 'local ');
  const remoteBefore = await counts(TARGET, 'remote');

  const remoteRows = Object.values(remoteBefore).reduce((a, b) => a + (b || 0), 0);
  if (remoteRows > 0) {
    console.log(`\nNote: the remote already holds ${remoteRows} rows; they will be replaced.`);
  }

  if (dryRun) {
    printCounts(before, remoteBefore);
    console.log('\nDry run — nothing was transferred.');
    return;
  }

  // --no-owner / --no-acl because the remote role differs from the local one.
  const args = [
    SOURCE,
    '--clean',
    '--if-exists',
    '--no-owner',
    '--no-acl',
    '--quote-all-identifiers',
  ];

  let dumpFile = null;
  if (keepFile) {
    const dir = path.join(__dirname, '..', 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    dumpFile = path.join(dir, `sfsapp-${stamp}.sql`);
  }

  console.log('\nTransferring…');

  await new Promise((resolve, reject) => {
    const dump = spawn('pg_dump', args, { shell: true });
    // ON_ERROR_STOP makes psql exit non-zero on the first failed statement.
    const restore = spawn('psql', [TARGET, '-v', 'ON_ERROR_STOP=1', '--quiet'], { shell: true });

    const fileStream = dumpFile ? fs.createWriteStream(dumpFile) : null;
    dump.stdout.on('data', (chunk) => {
      restore.stdin.write(chunk);
      if (fileStream) fileStream.write(chunk);
    });
    dump.stdout.on('end', () => {
      restore.stdin.end();
      if (fileStream) fileStream.end();
    });

    const dumpErr = [];
    const restoreErr = [];
    dump.stderr.on('data', (d) => dumpErr.push(d.toString()));
    restore.stderr.on('data', (d) => restoreErr.push(d.toString()));

    let dumpCode = null;
    let restoreCode = null;
    const settle = () => {
      if (dumpCode === null || restoreCode === null) return;
      // "does not exist, skipping" notices from --if-exists are expected.
      const noise = /does not exist, skipping|NOTICE:/i;
      const realDumpErr = dumpErr.join('').split('\n').filter((l) => l.trim() && !noise.test(l));
      const realRestoreErr = restoreErr.join('').split('\n').filter((l) => l.trim() && !noise.test(l));

      if (dumpCode !== 0) return reject(new Error(`pg_dump exited ${dumpCode}:\n${realDumpErr.join('\n')}`));
      if (restoreCode !== 0) return reject(new Error(`psql exited ${restoreCode}:\n${realRestoreErr.join('\n')}`));
      if (realRestoreErr.length) console.log(`  psql notes: ${realRestoreErr.slice(0, 5).join(' | ')}`);
      return resolve();
    };

    dump.on('close', (c) => { dumpCode = c; settle(); });
    restore.on('close', (c) => { restoreCode = c; settle(); });
    dump.on('error', reject);
    restore.on('error', reject);
  });

  const after = await counts(TARGET, 'remote');
  const ok = printCounts(before, after);

  if (dumpFile) console.log(`\nDump kept at ${path.relative(process.cwd(), dumpFile)}`);
  if (!ok) {
    console.error('\nRow counts differ — the backup is NOT a faithful copy.');
    process.exitCode = 1;
    return;
  }
  console.log('\nBackup complete — every table matches.');
}

main().catch((err) => {
  console.error(`\ndb:backup failed — ${err.message}`);
  process.exitCode = 1;
});
