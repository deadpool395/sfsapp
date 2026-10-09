'use strict';
/** Append-only audit trail for admin overrides and other notable actions. */

const db = require('../db/pool');

/**
 * Record an action. Pass `client` to join an open transaction so the audit
 * entry rolls back with the change it describes.
 */
async function log({ actor, action, entity, entityId, details = {} }, client = null) {
  const runner = client || db;
  await runner.query(
    `INSERT INTO audit_log (actor_type, actor_id, actor_name, action, entity, entity_id, details)
          VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      actor?.role || 'system',
      actor?.role === 'admin' ? actor.adminId : actor?.teacherId ?? null,
      actor?.displayName || null,
      action,
      entity || null,
      entityId || null,
      JSON.stringify(details),
    ]
  );
}

function recent(limit = 50) {
  return db.many('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT $1', [limit]);
}

function forEntity(entity, entityId) {
  return db.many(
    `SELECT * FROM audit_log WHERE entity = $1 AND entity_id = $2
      ORDER BY created_at DESC`,
    [entity, entityId]
  );
}

module.exports = { log, recent, forEntity };
