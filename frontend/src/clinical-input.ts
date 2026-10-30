import { isValidFdi } from "./clinical-contracts.ts";

import { ApiError } from "./api.ts";

/** Optional planned fees can be zero; only dentist-confirmed care becomes billable. */
export function plannedFeeMillimes(text: string): number {
  const m = /^(0|[1-9][0-9]{0,5})(?:[.,]([0-9]{1,3}))?$/.exec(text.trim());
  if (!m) throw new ApiError("VALIDATION_FAILED", 400);
  const n = Number(m[1]) * 1000 + Number((m[2] ?? "").padEnd(3, "0"));
  if (!Number.isSafeInteger(n) || n < 0 || n > 100_000_000)
    throw new ApiError("VALIDATION_FAILED", 400);
  return n;
}

const required = (value: FormDataEntryValue | null): string =>
  String(value ?? "").trim();
const invalid = (): never => { throw new ApiError("VALIDATION_FAILED", 400); };

export function findingInput(fields: FormData): Record<string, unknown> {
  const kind = required(fields.get("kind"));
  const tooth = Number(required(fields.get("toothFdi")));
  const conditionCode = required(fields.get("conditionCode")).toUpperCase();
  const note = required(fields.get("note"));
  if (!["EXISTING", "FINDING"].includes(kind) || !isValidFdi(tooth) ||
    !/^[A-Z][A-Z0-9_]{1,40}$/.test(conditionCode) || note.length > 500) invalid();
  return { kind, toothFdi: tooth, conditionCode, ...(note ? { note } : {}) };
}

export function planInput(fields: FormData, visitId: string): Record<string, unknown> {
  const procedureCode = required(fields.get("procedureCode")).toUpperCase();
  const procedureLabel = required(fields.get("procedureLabel"));
  const tooth = required(fields.get("toothFdi"));
  const estimate = required(fields.get("estimatedFee"));
  const phaseNo = Number(required(fields.get("phaseNo")));
  const note = required(fields.get("note"));
  if (!/^[A-Z0-9_.-]{2,32}$/.test(procedureCode) ||
    procedureLabel.length < 2 || procedureLabel.length > 160 ||
    !Number.isInteger(phaseNo) || phaseNo < 1 || phaseNo > 4 ||
    (tooth.length > 0 && !isValidFdi(Number(tooth))) || note.length > 500) invalid();
  return {
    visitId, procedureCode, procedureLabel, phaseNo,
    ...(tooth ? { toothFdi: Number(tooth) } : {}),
    ...(estimate ? { estimatedFeeMillimes: plannedFeeMillimes(estimate) } : {}),
    ...(note ? { note } : {}),
  };
}

export function statusInput(status: "ACCEPTED" | "DECLINED" | "CANCELLED", note: string) {
  const reason = note.trim();
  if (reason.length > 300 || (status !== "ACCEPTED" && reason.length < 3)) invalid();
  return { status, ...(reason ? { reason } : {}) };
}
