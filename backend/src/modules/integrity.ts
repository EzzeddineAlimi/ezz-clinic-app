/*
 * INTEGRITY module (read-only, owner): missing-record and tamper detection across modules (C5).
 * Depends on: audit (chain verification) and reads billing/care tables. Nothing depends on it.
 *
 * Detects: receipt-number gaps or counter drift; payments without a receipt (desk source); receipts whose
 * referenced records are missing; financial rows with no matching audit event (row inserted around the
 * application, e.g. directly in the database); audit chain breaks; owner-checkpoint mismatches.
 * Cannot detect: a payment that was never entered anywhere (CH-002).
 */
import type { Tx } from '../platform/db.ts';
import type { Route } from '../platform/http.ts';
import { asBody } from '../platform/validate.ts';
import { verifyChain, type Anchor } from './audit.ts';

export interface IntegrityFinding { check: string; severity: 'HIGH' | 'MEDIUM'; detail: string; refs?: unknown }

async function tableExists(tx: Tx, name: string) {
  return (await tx.one<{ ok: boolean }>('SELECT to_regclass($1) IS NOT NULL AS ok', [name])).ok;
}

export async function integrityCheck(tx: Tx, clinicId: string, anchors: Anchor[] = []) {
  const findings: IntegrityFinding[] = [];
  const nums = (await tx.query<{ number: number }>("SELECT number FROM receipts WHERE series = 'R' ORDER BY number")).rows.map(r => r.number);
  const missing: number[] = [];
  let expect = 1;
  for (const n of nums) { while (expect < n) missing.push(expect++); expect = n + 1; }
  if (missing.length) findings.push({ check: 'RECEIPT_NUMBER_GAP', severity: 'HIGH', detail: `Receipt numbers missing from the series: ${missing.slice(0, 20).map(n => 'R-' + String(n).padStart(6, '0')).join(', ')}${missing.length > 20 ? '…' : ''}`, refs: { missing } });
  const counter = await tx.maybeOne<{ next_number: number }>("SELECT next_number FROM receipt_counters WHERE series = 'R'");
  const max = nums.length ? nums[nums.length - 1]! : 0;
  if (counter && counter.next_number !== max + 1) findings.push({ check: 'RECEIPT_COUNTER_DRIFT', severity: 'HIGH', detail: `Counter says next is ${counter.next_number}, highest issued is ${max}` });

  const noReceipt = (await tx.query<{ id: string }>("SELECT p.id FROM payments p LEFT JOIN receipts r ON r.payment_id = p.id WHERE p.source = 'DESK' AND r.id IS NULL")).rows;
  if (noReceipt.length) findings.push({ check: 'PAYMENT_WITHOUT_RECEIPT', severity: 'HIGH', detail: `${noReceipt.length} desk payment(s) have no receipt`, refs: noReceipt.map(r => r.id) });

  const audited: [string, string, string][] = [
    ['payments', 'payment', 'payment.recorded'],
    ['care_items', 'care_item', 'care.%'],
    ['adjustments', 'adjustment', '%'],
  ];
  for (const [table, entity, actionLike] of audited) {
    const rows = (await tx.query<{ id: string }>(`SELECT t.id FROM ${table} t WHERE NOT EXISTS (
        SELECT 1 FROM audit_events e WHERE e.entity_type = $1 AND e.entity_id = t.id::text AND e.action LIKE $2)`, [entity, actionLike])).rows;
    if (rows.length) findings.push({ check: 'ROW_WITHOUT_AUDIT_EVENT', severity: 'HIGH', detail: `${rows.length} ${table} row(s) have no audit event (written around the application?)`, refs: rows.map(r => r.id) });
  }
  const orphanEvents = (await tx.query<{ entity_id: string }>(`SELECT e.entity_id FROM audit_events e WHERE e.action = 'payment.recorded'
      AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.id::text = e.entity_id)`)).rows;
  if (orphanEvents.length) findings.push({ check: 'AUDITED_PAYMENT_MISSING', severity: 'HIGH', detail: `${orphanEvents.length} audited payment(s) no longer exist in the payments table`, refs: orphanEvents.map(r => r.entity_id) });

  if (await tableExists(tx, 'cash_counts')) {
    const noAudit = (await tx.query<{ id: string }>(`SELECT c.id FROM cash_counts c WHERE NOT EXISTS (SELECT 1 FROM audit_events e WHERE e.entity_type = 'cash_count' AND e.entity_id = c.id::text)`)).rows;
    if (noAudit.length) findings.push({ check: 'ROW_WITHOUT_AUDIT_EVENT', severity: 'HIGH', detail: `${noAudit.length} cash count(s) have no audit event`, refs: noAudit.map(r => r.id) });
  }

  const chain = await verifyChain(tx, clinicId, anchors);
  for (const f of chain.findings) findings.push({ check: 'AUDIT_' + f.kind, severity: 'HIGH', detail: `seq ${f.seq}: ${f.detail}` });
  return {
    ok: findings.length === 0,
    receiptsIssued: nums.length,
    auditEvents: chain.eventCount,
    auditHead: { seq: chain.lastSeq, hash: chain.lastHash },
    findings,
    scope: 'Checks recorded entries only. A payment never entered anywhere cannot be detected (CH-002).',
  };
}

export const integrityRoutes: Route[] = [
  {
    method: 'POST', path: '/api/v1/integrity/check', permission: 'audit.verify',
    handler: async ({ tx, actor, body }) => {
      const b = asBody(body);
      const anchors = Array.isArray(b.anchors) ? (b.anchors as Anchor[]).filter(a => a && Number.isSafeInteger(a.seq) && typeof a.hash === 'string' && /^[0-9a-f]{64}$/.test(a.hash)) : [];
      return { status: 200, body: await integrityCheck(tx, actor!.clinicId, anchors) };
    },
  },
];
