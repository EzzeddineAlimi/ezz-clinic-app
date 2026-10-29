import { z } from "zod";
const money = z.number().int().safe();
export const balanceSchema = z.object({
  balance: z.object({
    visitId: z.string(),
    chargedMillimes: money,
    paidMillimes: money,
    reducedMillimes: money,
    returnedMillimes: money,
    balanceMillimes: money,
    careConfirmed: z.boolean(),
  }),
});
export const historySchema = z.object({
  visitId: z.string(),
  payments: z.array(
    z.object({
      id: z.string(),
      amountMillimes: money,
      tender: z.enum(["CASH", "CARD"]),
      recordedAt: z.string(),
      receiptNumber: money.nullable(),
      returnedMillimes: money,
    }),
  ),
});
export const paymentSchema = z.object({
  payment: z.object({
    id: z.string(),
    amountMillimes: money,
    tender: z.enum(["CASH", "CARD"]),
    evidence: z.object({ tier: z.string(), verifiedBy: z.null() }),
  }),
  receipt: z.object({ id: z.string(), number: money, label: z.string() }),
  balanceAfterMillimes: money,
});
export const receiptSchema = z.object({
  receipt: z.object({
    id: z.string(),
    number: money,
    snapshotSha256: z.string(),
    snapshot: z.object({
      label: z.string(),
      notice: z.string(),
      patient: z.object({ name: z.string(), fileNo: money }),
      amountMillimes: money,
      balanceAfterMillimes: money,
      tender: z.enum(["CASH", "CARD"]),
    }),
  }),
});
export const periodSchema = z.object({
  period: z.object({ id: z.string() }).nullable(),
});
export const printSchema = z.object({
  copy: z.boolean(),
  copyNo: money,
  document: z.object({
    reference: z.string(),
    sections: z.array(
      z.object({
        lang: z.string(),
        dir: z.enum(["ltr", "rtl"]),
        title: z.string(),
        mark: z.string().nullable(),
        notice: z.string(),
        lines: z.array(
          z.object({
            key: z.string(),
            label: z.string(),
            value: z.string(),
            isolate: z.boolean(),
          }),
        ),
      }),
    ),
  }),
});
export function tndToMillimes(text: string): number {
  const m = /^(0|[1-9][0-9]{0,5})(?:[.,]([0-9]{1,3}))?$/.exec(text.trim());
  if (!m) throw new Error("INVALID_AMOUNT");
  const n = Number(m[1]) * 1000 + Number((m[2] ?? "").padEnd(3, "0"));
  if (n <= 0 || n > 100_000_000) throw new Error("INVALID_AMOUNT");
  return n;
}
export function amount(m: number) {
  return `${m < 0 ? "-" : ""}${Math.floor(Math.abs(m) / 1000)}.${String(Math.abs(m) % 1000).padStart(3, "0")} TND`;
}
/** Frozen from first submission, including confirmed failures. */
export class PaymentIntent {
  readonly key = crypto.randomUUID();
  private body:
    | Readonly<{ amountMillimes: number; tender: "CASH" | "CARD" }>
    | undefined;
  payload(candidate: { amountMillimes: number; tender: "CASH" | "CARD" }) {
    this.body ??= Object.freeze({ ...candidate });
    return this.body;
  }
}
