/*
 * Error convention: modules throw AppError with a stable machine code; the HTTP layer maps it to
 * { error: { code, message, details? } }. Messages are neutral and never contain patient data.
 * Unknown errors become 500 INTERNAL with no internal detail leaked to the client.
 */
export const ErrorCodes = {
  VALIDATION_FAILED: 400,
  UNSUPPORTED_MEDIA_TYPE: 415,
  PAYLOAD_TOO_LARGE: 413,
  UNAUTHENTICATED: 401,
  REAUTH_REQUIRED: 401,
  ACCOUNT_LOCKED: 423,
  FORBIDDEN_ROLE: 403,
  FORBIDDEN_ORIGIN: 403,
  MISDIRECTED_HOST: 421,
  NOT_FOUND: 404,
  CONFLICT: 409,
  CARE_ALREADY_CONFIRMED: 409,
  CARE_NOT_CONFIRMED: 409,
  AMOUNT_EXCEEDS_BALANCE: 409,
  POSSIBLE_DUPLICATE_PAYMENT: 409,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  IDEMPOTENCY_KEY_REUSED: 409,
  NO_OPEN_CASH_PERIOD: 409,
  CASH_PERIOD_CLOSED: 409,
  RECOUNT_REASON_REQUIRED: 400,
  COUNTER_NOT_ALLOWED: 403,
  STATEMENT_SCOPE_REJECTED: 422,
  STATEMENT_TOTAL_MISMATCH: 422,
  STATEMENT_OVERLAP_CONFLICT: 409,
  PAPER_SLIP_OUT_OF_RANGE: 422,
  PAPER_VOID_WITH_AMOUNT: 422,
  ALREADY_VOIDED: 409,
  SITE_UNCHANGED: 409,
  SITE_AMENDMENT_STALE: 409,
  MEDICAL_ALERTS_CHANGED: 409,
  MEDICAL_ALERTS_NOT_ACKNOWLEDGED: 409,
  PLAN_ITEM_CLOSED: 409,
  INTERNAL: 500,
} as const;
export type ErrorCode = keyof typeof ErrorCodes;

export class AppError extends Error {
  code: ErrorCode;
  details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
  get status(): number { return ErrorCodes[this.code]; }
}

export const fail = (code: ErrorCode, message: string, details?: unknown): never => {
  throw new AppError(code, message, details);
};
