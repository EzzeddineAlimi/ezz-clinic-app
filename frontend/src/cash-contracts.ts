import { z } from "zod";

const nonnegative = z.number().int().safe().nonnegative();
const reference = z.string().uuid();

export const ownerCashPeriodSchema = z.object({
  period: z.object({
    id: reference,
    periodNo: nonnegative,
    openedAt: z.string(),
    status: z.literal("OPEN"),
    countAttempts: nonnegative,
    blind: z.literal(true),
    note: z.string(),
  }).nullable(),
});

export const openCashPeriodSchema = z.object({
  period: z.object({
    id: reference,
    periodNo: nonnegative,
    openedAt: z.string(),
    status: z.literal("OPEN"),
  }),
});

export const submittedCashCountSchema = z.object({
  count: z.object({
    id: reference,
    periodId: reference,
    attemptNo: nonnegative,
    submittedAt: z.string(),
  }),
  status: z.literal("RECORDED_PENDING_OWNER_REVIEW"),
});

export const cashReviewSchema = z.object({
  period: z.object({
    id: reference,
    periodNo: nonnegative,
    status: z.enum(["OPEN", "CLOSED"]),
    openedAt: z.string(),
  }),
  expected: z.object({
    expectedMillimes: z.number().int().safe(),
    breakdown: z.object({
      openingFloatMillimes: nonnegative,
      cashPaymentsMillimes: nonnegative,
      cashPaymentCount: nonnegative,
      floatTopUpsMillimes: nonnegative,
      ownerWithdrawalsMillimes: nonnegative,
      bankDepositsMillimes: nonnegative,
      pettyExpensesMillimes: nonnegative,
      cashRefundsMillimes: nonnegative,
      cashVoidsMillimes: nonnegative,
    }),
  }),
  attempts: z.array(z.object({
    id: reference,
    attemptNo: nonnegative,
    countedBy: reference,
    countedMillimes: nonnegative,
    expectedMillimes: z.number().int().safe(),
    differenceMillimes: z.number().int().safe(),
    submittedAt: z.string(),
    recountReason: z.string().nullable(),
    counterIndependent: z.boolean(),
    independenceNotes: z.string(),
    wording: z.string(),
  })).min(1),
  cashRecordedAfterLatestCount: z.object({
    count: nonnegative,
    totalMillimes: nonnegative,
    note: z.string(),
  }),
  evidence: z.enum(["COUNTED_BY_NON_RECEPTIONIST (software check)", "COUNT_NOT_INDEPENDENT"]),
  scope: z.string(),
});

export const closedCashPeriodSchema = z.object({
  closed: z.object({
    id: reference,
    cutoffAt: z.string(),
    differenceMillimes: z.number().int().safe(),
    handoverMillimes: nonnegative,
  }),
  nextPeriod: z.object({
    id: reference,
    periodNo: nonnegative,
    openingFloatMillimes: nonnegative,
    openingBasis: z.literal("COUNTED_CARRY_FORWARD"),
  }),
});

/** Exact millime parser, allowing an empty drawer (0) and forbidding floats/rounding. */
export function parseDrawerMillimes(input: string): number {
  const matched = /^(0|[1-9][0-9]{0,6})(?:[.,]([0-9]{1,3}))?$/.exec(input.trim());
  if (!matched) throw new Error("INVALID_DRAWER_AMOUNT");
  const value = Number(matched[1]) * 1000 + Number((matched[2] ?? "").padEnd(3, "0"));
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000) {
    throw new Error("INVALID_DRAWER_AMOUNT");
  }
  return value;
}

export type OwnerCashPeriod = z.infer<typeof ownerCashPeriodSchema>["period"];
export type CashReview = z.infer<typeof cashReviewSchema>;
