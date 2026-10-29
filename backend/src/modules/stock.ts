/*
 * BASIC STOCK module (R73-E). Owns: stock_items, stock_movements (append-only ledger). Depends on: audit, settings.
 *
 * On-hand quantity = the running total of movements, stored on every row (on_hand_after) under a per-item lock so it can
 * never go below zero and can be re-verified by the integrity check. RECEIVED and USED are everyday entries (owner,
 * dentist, assistant; the receptionist's workload is untouched); ADJUSTED (count correction, signed) and DISCARDED
 * (expired/damaged) need the owner and a reason. No automatic ordering, no supplier integration, no clinical rule
 * (which material to use is never suggested). Lots and expiry dates are recorded on receipt; per-lot consumption is
 * NOT tracked, so the expiry list says "received lots", not "lots still on the shelf".
 */
import type { Tx } from '../platform/db.ts';
import type { Actor, Route } from '../platform/http.ts';
import { fail } from '../platform/errors.ts';
import { asBody, str, optStr, int, isoDate, isUuid } from '../platform/validate.ts';
import { appendAudit } from './audit.ts';
import { clinicTimezone, localDate } from './settings.ts';

export const EXPIRY_WINDOW_DAYS = 30;
type Kind = 'RECEIVED' | 'USED' | 'ADJUSTED' | 'DISCARDED';

async function loadItem(tx: Tx, id: string) {
  if (!isUuid(id)) fail('NOT_FOUND', 'Stock item not found');
  const i = await tx.maybeOne<{ id: string; name: string; unit: string; reorder_level: number | null }>('SELECT id, name, unit, reorder_level FROM stock_items WHERE id = $1', [id]);
  if (!i) fail('NOT_FOUND', 'Stock item not found');
  return i!;
}

/** Append one movement; quantity is signed (+ in, - out). Serialised per item; refuses to go below zero. */
export async function recordMovement(tx: Tx, actor: Actor, itemId: string, m: { kind: Kind; quantity: number; lot?: string | null; expiresOn?: string | null; reason?: string | null }) {
  const item = await loadItem(tx, itemId);
  await tx.query("SELECT pg_advisory_xact_lock(hashtext('stock_item:' || $1))", [item.id]);
  const cur = await tx.one<{ n: number; seq: number }>(
    'SELECT coalesce((SELECT on_hand_after FROM stock_movements WHERE item_id = $1 ORDER BY seq DESC LIMIT 1), 0)::int AS n, coalesce((SELECT max(seq) FROM stock_movements WHERE item_id = $1), 0)::int AS seq', [item.id]);
  const after = cur.n + m.quantity;
  if (after < 0) fail('CONFLICT', `Only ${cur.n} ${item.unit} recorded on hand; cannot remove ${-m.quantity}. Record the missing receipt or an owner adjustment first.`, { onHand: cur.n, requested: -m.quantity });
  const r = await tx.one<{ id: string; at: string }>(`INSERT INTO stock_movements (clinic_id, item_id, seq, kind, quantity, lot, expires_on, reason, on_hand_after, by_staff_id)
      VALUES ($1,$2,$10,$3,$4,$5,$6,$7,$8,$9) RETURNING id, at`, [actor.clinicId, item.id, m.kind, m.quantity, m.lot ?? null, m.expiresOn ?? null, m.reason ?? null, after, actor.staffId, cur.seq + 1]);
  await appendAudit(tx, actor, 'stock.movement', 'stock_movement', r.id, { itemId: item.id, seq: cur.seq + 1, kind: m.kind, quantity: m.quantity, onHandAfter: after, hasReason: !!m.reason });
  return { id: r.id, itemId: item.id, seq: cur.seq + 1, kind: m.kind, quantity: m.quantity, onHandAfter: after, at: new Date(r.at).toISOString() };
}

const positive = (b: Record<string, unknown>) => int(b, 'quantity', 1, 1_000_000)!;
const reasonOf = (b: Record<string, unknown>) => str(b, 'reason', { min: 3, max: 300 });

export const stockRoutes: Route[] = [
  {
    method: 'POST', path: '/api/v1/stock/items', permission: 'stock.manage', idempotent: true,
    handler: async ({ tx, actor, body }) => {
      const b = asBody(body);
      const name = str(b, 'name', { min: 2, max: 120 });
      const unit = str(b, 'unit', { max: 20 });
      const reorderLevel = int(b, 'reorderLevel', 0, 1_000_000, true);
      const r = await tx.one<{ id: string }>('INSERT INTO stock_items (clinic_id, name, unit, reorder_level, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id', [actor!.clinicId, name, unit, reorderLevel, actor!.staffId]);
      await appendAudit(tx, actor!, 'stock.item_created', 'stock_item', r.id, { name, unit, reorderLevel });
      return { status: 201, body: { item: { id: r.id, name, unit, reorderLevel, onHand: 0 } } };
    },
  },
  {
    method: 'GET', path: '/api/v1/stock/items', permission: 'stock.read',
    handler: async ({ tx, actor }) => {
      const today = localDate(await clinicTimezone(tx, actor!.clinicId));
      const items = (await tx.query<{ id: string; name: string; unit: string; reorder_level: number | null; on_hand: number }>(
        `SELECT i.id, i.name, i.unit, i.reorder_level,
                coalesce((SELECT m.on_hand_after FROM stock_movements m WHERE m.item_id = i.id ORDER BY m.seq DESC LIMIT 1), 0)::int AS on_hand
           FROM stock_items i ORDER BY lower(i.name)`)).rows;
      const lots = (await tx.query<{ item_id: string; lot: string | null; expires_on: string; quantity: number }>(
        `SELECT item_id, lot, expires_on::text AS expires_on, quantity FROM stock_movements
          WHERE kind = 'RECEIVED' AND expires_on IS NOT NULL AND expires_on <= $1::date + $2::int ORDER BY expires_on`, [today, EXPIRY_WINDOW_DAYS])).rows;
      return { status: 200, body: {
        clinicToday: today,
        items: items.map(i => ({ id: i.id, name: i.name, unit: i.unit, reorderLevel: i.reorder_level, onHand: i.on_hand,
          belowReorderLevel: i.reorder_level !== null && i.on_hand <= i.reorder_level,
          receivedLotsExpiringSoon: lots.filter(l => l.item_id === i.id).map(l => ({ lot: l.lot, expiresOn: l.expires_on, receivedQuantity: l.quantity, expired: l.expires_on < today })) })),
        note: `Expiry list = lots RECEIVED with an expiry within ${EXPIRY_WINDOW_DAYS} days; consumption per lot is not tracked, so a listed lot may already be used up.`,
      } };
    },
  },
  {
    method: 'GET', path: '/api/v1/stock/items/:id/movements', permission: 'stock.read',
    handler: async ({ tx, params }) => {
      const item = await loadItem(tx, params.id!);
      const rows = (await tx.query<{ id: string; seq: number; kind: string; quantity: number; lot: string | null; expires_on: string | null; reason: string | null; on_hand_after: number; name: string; at: string }>(
        `SELECT m.id, m.seq, m.kind, m.quantity, m.lot, m.expires_on::text AS expires_on, m.reason, m.on_hand_after, s.display_name AS name, m.at
           FROM stock_movements m JOIN staff s ON s.id = m.by_staff_id WHERE m.item_id = $1 ORDER BY m.seq DESC LIMIT 500`, [item.id])).rows;
      return { status: 200, body: { item, movements: rows.map(r => ({ id: r.id, seq: r.seq, kind: r.kind, quantity: r.quantity, lot: r.lot, expiresOn: r.expires_on, reason: r.reason, onHandAfter: r.on_hand_after, by: r.name, at: new Date(r.at).toISOString() })) } };
    },
  },
  {
    // Everyday entries: goods received (quantity > 0, optional lot/expiry) and goods used (quantity > 0, removed).
    method: 'POST', path: '/api/v1/stock/items/:id/movements', permission: 'stock.record', idempotent: true,
    handler: async ({ tx, actor, params, body }) => {
      const b = asBody(body);
      const kind = b.kind;
      if (kind !== 'RECEIVED' && kind !== 'USED') fail('VALIDATION_FAILED', 'kind must be RECEIVED or USED (adjustments and discards are owner entries)', { field: 'kind' });
      const q = positive(b);
      const movement = kind === 'RECEIVED'
        ? await recordMovement(tx, actor!, params.id!, { kind, quantity: q, lot: optStr(b, 'lot', { max: 60 }), expiresOn: isoDate(b, 'expiresOn', true) })
        : await recordMovement(tx, actor!, params.id!, { kind: 'USED', quantity: -q });
      return { status: 201, body: { movement } };
    },
  },
  {
    // Owner corrections: ADJUSTED takes a signed delta (a physical count differs); DISCARDED removes expired/damaged stock.
    method: 'POST', path: '/api/v1/stock/items/:id/adjustments', permission: 'stock.manage', idempotent: true,
    handler: async ({ tx, actor, params, body }) => {
      const b = asBody(body);
      const kind = b.kind;
      if (kind !== 'ADJUSTED' && kind !== 'DISCARDED') fail('VALIDATION_FAILED', 'kind must be ADJUSTED or DISCARDED', { field: 'kind' });
      const reason = reasonOf(b);
      let quantity: number;
      if (kind === 'DISCARDED') quantity = -positive(b);
      else {
        quantity = int(b, 'quantity', -1_000_000, 1_000_000)!;
        if (quantity === 0) fail('VALIDATION_FAILED', 'quantity must not be zero', { field: 'quantity' });
      }
      return { status: 201, body: { movement: await recordMovement(tx, actor!, params.id!, { kind: kind as Kind, quantity, reason }) } };
    },
  },
];
