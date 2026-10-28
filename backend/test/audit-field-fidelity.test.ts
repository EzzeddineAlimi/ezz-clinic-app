/*
 * CH-026 / SEC-01: persistent PostgreSQL regression.
 * A privileged database actor can bypass append-only triggers, so the verifier
 * must compare EVERY stored audit field with the externally anchored canonical event.
 * These are synthetic tampering tests; not evidence of a receptionist-level exploit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, startApi, standardFixture, confirmCare, adminConn } from './helpers.ts';

const mutations: { label: string; sql: string }[] = [
  { label: 'JSONB payload', sql: "payload = jsonb_set(payload, '{amountMillimes}', '900000'::jsonb)" },
  { label: 'actor roles', sql: "actor_roles = 'RECEPTIONIST'" },
  { label: 'entity type', sql: "entity_type = 'fake_payment'" },
  { label: 'timestamp', sql: "occurred_at = occurred_at + interval '1 day'" },
];

for (const mutation of mutations) {
  test(`CH-026: altered stored ${mutation.label} is detected even with canonical hash and outside anchor unchanged`, async () => {
    const db = await createTestDb();
    const api = await startApi(db.appUrl);
    try {
      const f = await standardFixture(api, db, 'audit-fidelity');
      await confirmCare(api, f.dentist, f.visitId, 100_000);
      const payment = await api.call('POST', `/api/v1/visits/${f.visitId}/payments`, {
        token: f.desk, body: { amountMillimes: 70_000, tender: 'CASH' },
      });
      assert.equal(payment.status, 201);
      const before = await api.call('POST', '/api/v1/audit/verify', { token: f.owner, body: {} });
      assert.equal(before.body.ok, true);
      const outsideAnchor = { seq: before.body.lastSeq, hash: before.body.lastHash };
      const a = await adminConn(db.name);
      try {
        const events = await a.query<{ seq: number }>(
          "SELECT seq FROM audit_events WHERE clinic_id = $1 AND action = 'payment.recorded' ORDER BY seq LIMIT 1",
          [f.clinic.id]
        );
        assert.equal(events.rows.length, 1);
        await a.exec('BEGIN; SET LOCAL session_replication_role = replica;');
        const update = await a.query(
          `UPDATE audit_events SET ${mutation.sql} WHERE clinic_id = $1 AND seq = $2`,
          [f.clinic.id, events.rows[0]!.seq]
        );
        assert.equal(update.rowCount, 1);
        await a.exec('COMMIT');
      } finally {
        a.end();
      }
      const after = await api.call('POST', '/api/v1/audit/verify', {
        token: f.owner, body: { anchors: [outsideAnchor] },
      });
      assert.equal(after.status, 200);
      assert.equal(after.body.ok, false, `altered ${mutation.label} was not detected`);
      assert.ok(after.body.findings.some((x: { kind: string }) => x.kind === 'CANONICAL_MISMATCH'),
        `expected CANONICAL_MISMATCH for ${mutation.label}: ${JSON.stringify(after.body.findings)}`);
    } finally {
      await api.close();
      await db.drop();
    }
  });
}
