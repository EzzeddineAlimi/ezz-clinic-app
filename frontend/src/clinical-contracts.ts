import { z } from "zod";

const uuid = z.string().uuid();
const integer = z.number().int().safe();
export const noteSchema = z.object({
  id: uuid,
  visitId: uuid,
  kind: z.enum(["NOTE", "LATE_ENTRY", "ADDENDUM", "ENTERED_IN_ERROR"]),
  subjective: z.string().nullable(),
  objective: z.string().nullable(),
  assessment: z.string().nullable(),
  plan: z.string().nullable(),
  reason: z.string().nullable(),
  signedByName: z.string(),
  signedAt: z.string(),
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  integrity: z.enum(["OK", "CONTENT_HASH_MISMATCH"]).optional(),
  enteredInError: z.object({
    by: z.string(), at: z.string(), reason: z.string(),
  }).nullable().optional(),
});
export const findingSchema = z.object({
  id: uuid,
  visitId: uuid,
  kind: z.enum(["EXISTING", "FINDING"]),
  toothFdi: integer.nullable(),
  areaCode: integer.nullable(),
  surfaces: z.string().nullable(),
  conditionCode: z.string(),
  note: z.string().nullable(),
  recordedByName: z.string(),
  recordedAt: z.string(),
  enteredInError: z.object({
    by: z.string(), at: z.string(), reason: z.string(),
  }).nullable().optional(),
});
export const planItemSchema = z.object({
  id: uuid,
  patientId: uuid,
  procedureCode: z.string(),
  procedureLabel: z.string(),
  toothFdi: integer.nullable(),
  surfaces: z.string().nullable(),
  phaseNo: integer,
  estimatedFeeMillimes: integer.nullable(),
  note: z.string().nullable(),
  createdByName: z.string(),
  createdAt: z.string(),
  status: z.enum(["PROPOSED", "ACCEPTED", "DECLINED", "CANCELLED", "COMPLETED"]),
  lastSeq: integer,
  careItemId: uuid.nullable(),
});
export const encounterSchema = z.object({
  syntheticDataOnly: z.literal(true),
  visit: z.object({ id: uuid, status: z.string(), scheduledAt: z.string() }),
  patient: z.object({
    id: uuid, fileNo: integer, familyName: z.string(), givenName: z.string(),
  }),
  medical: z.object({
    activeAlerts: z.array(z.object({
      id: uuid,
      code: z.string(),
      severity: z.enum(["CRITICAL", "CAUTION"]),
      detail: z.string().nullable(),
      source: z.enum(["PATIENT_DECLARED", "DENTIST_VERIFIED"]),
    })),
    treatmentGate: z.enum([
      "NO_ACTIVE_ALERTS", "ACKNOWLEDGED", "SEND_ALERT_SET_HASH_WITH_CARE_OR_ACKNOWLEDGE",
    ]),
  }),
  notes: z.array(noteSchema),
  findings: z.array(findingSchema),
  planItems: z.array(planItemSchema),
});
export type Encounter = z.infer<typeof encounterSchema>;
export type PlanItem = z.infer<typeof planItemSchema>;
export type ClinicalNote = z.infer<typeof noteSchema>;

export const noteCreatedSchema = z.object({
  note: noteSchema.omit({ integrity: true, enteredInError: true }),
});
export const findingCreatedSchema = z.object({
  finding: findingSchema.omit({ enteredInError: true }),
});
export const planItemCreatedSchema = z.object({ planItem: planItemSchema });

/** Strict ISO 3950 two-digit FDI tooth check; the server remains authoritative. */
export function isValidFdi(tooth: number): boolean {
  if (!Number.isSafeInteger(tooth)) return false;
  const quadrant = Math.floor(tooth / 10);
  const position = tooth % 10;
  return quadrant >= 1 && quadrant <= 4 ? position >= 1 && position <= 8
    : quadrant >= 5 && quadrant <= 8 && position >= 1 && position <= 5;
}

export function nonemptyNote(sections: {
  subjective: string; objective: string; assessment: string; plan: string;
}): boolean {
  return Object.values(sections).some(value => value.trim().length > 0);
}
