import { z } from "zod";
import { balanceSchema, paymentSchema } from "./billing.ts";

const money = z.number().int().safe();
const tender = z.enum(["CASH", "CARD"]);

export const recoverySchema = z.object({
  balance: balanceSchema.shape.balance,
  recoveryVersion: z.string().regex(/^[0-9a-f]{64}$/),
  paymentIds: z.array(z.string().uuid()),
  automaticRetry: z.literal(false),
  pendingAnomaly: z.boolean(),
  intentions: z.array(z.object({
    id: z.string().uuid(),
    payload: z.object({
      amountMillimes: money.positive(),
      tender,
      cardTerminalRef: z.string().nullable().optional(),
      cardLast4: z.string().nullable().optional(),
      confirmDuplicate: z.boolean().optional(),
    }),
    createdBy: z.string(),
    createdAt: z.string(),
    status: z.enum(["PENDING", "RECORDED", "CANCELLED"]),
    paymentId: z.string().nullable(),
    result: paymentSchema.nullable(),
    reason: z.string().nullable(),
    resolvedBy: z.string().nullable(),
  })),
});
export type PaymentRecovery = z.infer<typeof recoverySchema>;
export type DurableIntent = PaymentRecovery["intentions"][number];

export const preparedIntentSchema = z.object({
  intent: z.object({
    id: z.string().uuid(),
    status: z.literal("PENDING"),
    payload: z.object({ amountMillimes: money.positive(), tender }),
  }),
  paymentRecorded: z.literal(false),
});
export const recordedIntentSchema = paymentSchema.extend({
  recovered: z.boolean().optional(),
  replayed: z.boolean().optional(),
});
export const cancelledIntentSchema = z.object({
  status: z.literal("CANCELLED"),
  paymentRecorded: z.literal(false).optional(),
  recovered: z.boolean().optional(),
});

/** The server's ordered ledger IDs must match the history the staff is acknowledging. */
export function historyMatchesRecovery(
  recovery: PaymentRecovery,
  payments: ReadonlyArray<{ id: string }>,
): boolean {
  // Recovery sorts by payment UUID; history sorts by recorded time.
  // Compare unique IDs as sets, but send the server-owned order on writes.
  const expected = new Set(recovery.paymentIds);
  const actual = new Set(payments.map(p => p.id));
  return expected.size === recovery.paymentIds.length &&
    actual.size === payments.length &&
    expected.size === actual.size &&
    [...expected].every(id => actual.has(id));
}
