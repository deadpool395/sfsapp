'use strict';
/**
 * Create the application database if it does not exist yet.
 * Connects to the maintenance database `postgres` on the same server.
 */
require('dotenv').config();

const { Client } = require('pg');

async function main() {
  const url = new URL(process.env.DATABASE_URL);
  const dbName = decodeURIComponent(url.pathname.replace(/^\//, ''));

  if (!dbName) {
    console.error('DATABASE_URL has no database name.');
    process.exit(1);
  }

  const adminUrl = new URL(url.toString());
  adminUrl.pathname = '/postgres';

  const client = new Client({ connectionString: adminUrl.toString() });
  await client.connect();

  try {
    const { rows } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (rows.length) {
      console.log(`Database "${dbName}" already exists.`);
    } else {
      // Identifiers cannot be parameterised, so quote it defensively.
      await client.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
      console.log(`Created database "${dbName}".`);
    }

    const { rows: ver } = await client.query('SHOW server_version');
    console.log(`Server: PostgreSQL ${ver[0].server_version} on port ${url.port || 5432}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('db:create failed —', err.message);
  process.exit(1);
});
