'use strict';
require('dotenv').config();

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env first.');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

pool.on('error', (err) => {
  console.error('Unexpected idle client error:', err.message);
});

/** Run a query against the pool. */
function query(text, params) {
  return pool.query(text, params);
}

/** First row of a query, or undefined. */
async function one(text, params) {
  const { rows } = await pool.query(text, params);
  return rows[0];
}

/** All rows of a query. */
async function many(text, params) {
  const { rows } = await pool.query(text, params);
  return rows;
}

/**
 * Run `fn` inside a transaction, passing it a dedicated client.
 * Rolls back and rethrows on any error.
 */
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* the connection is already broken; the original error matters more */
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, one, many, transaction };
