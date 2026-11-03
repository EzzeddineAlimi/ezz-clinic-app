/**
 * GitHub Codespaces' *private* forwarded ports use a GitHub-owned session cookie.
 * Allow the browser to send that cookie to this exact HTTPS preview origin only.
 * EZZ itself still stores no cookies and always requires its own bearer token.
 */
export function credentialsForOrigin(origin: string): RequestCredentials {
  return /^https:\/\/[a-z0-9-]+-5173\.app\.github\.dev$/.test(origin)
    ? "same-origin"
    : "omit";
}

import { z } from "zod";
import { ownerCashPeriodSchema, openCashPeriodSchema, submittedCashCountSchema, cashReviewSchema, closedCashPeriodSchema } from "./cash-contracts.ts";
import { encounterSchema, noteCreatedSchema, findingCreatedSchema, planItemCreatedSchema } from "./clinical-contracts.ts";
import { recoverySchema, preparedIntentSchema, recordedIntentSchema, cancelledIntentSchema } from "./recovery.ts";
import {
  balanceSchema,
  historySchema,
  paymentSchema,
  receiptSchema,
  printSchema,
  periodSchema,
} from "./billing.ts";

const staff = z.object({
  id: z.string(),
  displayName: z.string(),
  roles: z.array(z.enum(["OWNER", "DENTIST", "RECEPTIONIST", "ASSISTANT"])),
});
export const sessionSchema = z.object({ staff, clinicId: z.string() });
const loginSchema = sessionSchema.extend({ token: z.string().min(1) });
export const patientSchema = z.object({
  id: z.string(),
  fileNo: z.number().int(),
  familyName: z.string(),
  givenName: z.string(),
  nameAr: z.string().nullable().optional(),
  contactPreference: z.string(),
  preferredLanguage: z.string().optional(),
  phone: z.string().nullable().optional(),
  dateOfBirth: z.string().nullable().optional(),
  birthYear: z.string().nullable().optional(),
  phoneLast4: z.string().nullable().optional(),
  hasSameNameInClinic: z.boolean().optional(),
});
export const visitSchema = z.object({
  id: z.string(),
  localTime: z.string(),
  scheduledAt: z.string(),
  durationMin: z.number().int(),
  status: z.enum([
    "SCHEDULED",
    "ARRIVED",
    "IN_CHAIR",
    "COMPLETED",
    "NO_SHOW",
    "CANCELLED",
  ]),
  patient: patientSchema,
  dentist: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  flags: z.array(z.string()),
  waitingMinutes: z.number().nullable(),
  balanceDueMillimes: z.number().int().optional(),
  statusReason: z.string().nullable().optional(),
});
export const boardSchema = z.object({
  day: z.string(),
  timezone: z.string(),
  scope: z.string(),
  summary: z.object({
    total: z.number().int(),
    byStatus: z.record(z.string(), z.number().int()),
    notArrivedPastStart: z.number().int(),
  }),
  visits: z.array(visitSchema),
});
export type Session = z.infer<typeof sessionSchema>;
export type Patient = z.infer<typeof patientSchema>;
export type Board = z.infer<typeof boardSchema>;
export type Visit = z.infer<typeof visitSchema>;
export class ApiError extends Error {
  code: string;
  status: number;
  details: Record<string, unknown>;
  requestId: string;
  constructor(
    code: string,
    status = 0,
    details: Record<string, unknown> = {},
    requestId = "",
  ) {
    super(code);
    this.code = code;
    this.status = status;
    this.details = details;
    this.requestId = requestId;
  }
}
export class Api {
  private token: string;
  private expired: () => void;
  constructor(token = "", expired: () => void = () => {}) {
    this.token = token;
    this.expired = expired;
  }
  async call<T>(
    path: string,
    schema: z.ZodType<T>,
    options: { body?: unknown; key?: string; signal?: AbortSignal } = {},
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch("/api/v1" + path, {
        method: options.body === undefined ? "GET" : "POST",
        credentials: typeof window === "undefined" ? "omit" : credentialsForOrigin(window.location.origin),
        cache: "no-store",
        redirect: "error",
        headers: {
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          ...(options.body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
          ...(options.key ? { "Idempotency-Key": options.key } : {}),
        },
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)])
          : AbortSignal.timeout(15000),
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new ApiError("NETWORK");
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      // A proxy may replace a 401 body with HTML/truncated JSON. Authentication
      // still failed; only a parsable REAUTH_REQUIRED envelope may preserve it.
      if (response.status === 401 && this.token) {
        this.expired();
        throw new ApiError("UNAUTHENTICATED", 401);
      }
      throw new ApiError(
        options.body === undefined ? "INVALID_RESPONSE" : "NETWORK",
        response.status,
      );
    }
    if (!response.ok) {
      const parsed = z
        .object({
          error: z.object({
            code: z.string(),
            details: z.record(z.string(), z.unknown()).optional(),
          }),
        })
        .safeParse(data);
      if (
        response.status === 401 &&
        this.token &&
        parsed.data?.error.code !== "REAUTH_REQUIRED"
      )
        this.expired();
      throw new ApiError(
        parsed.data?.error.code ?? "INTERNAL",
        response.status,
        parsed.data?.error.details,
        response.headers.get("X-Request-Id") ?? "",
      );
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success)
      throw new ApiError(
        options.body === undefined ? "INVALID_RESPONSE" : "NETWORK",
        response.status,
        {},
        response.headers.get("X-Request-Id") ?? "",
      );
    return parsed.data;
  }
  balance(id: string, signal?: AbortSignal) {
    return this.call(`/visits/${id}/balance`, balanceSchema, { signal });
  }
  payments(id: string, signal?: AbortSignal) {
    return this.call(`/visits/${id}/payments`, historySchema, { signal });
  }
  cashPeriod(signal?: AbortSignal) {
    return this.call("/cash/periods/current", periodSchema, { signal });
  }
  paymentRecovery(id: string, signal?: AbortSignal) {
    return this.call(`/visits/${id}/payment-recovery`, recoverySchema, { signal });
  }
  preparePayment(id: string, body: {
    amountMillimes: number;
    tender: "CASH" | "CARD";
    recoveryVersion: string;
    acknowledgedPaymentIds: string[];
    confirmDuplicate?: boolean;
  }, key: string) {
    return this.call(`/visits/${id}/payment-intents`, preparedIntentSchema, { body, key });
  }
  recordPaymentIntent(id: string, key: string) {
    return this.call(`/payment-intents/${id}/record`, recordedIntentSchema, { body: {}, key });
  }
  cancelPaymentIntent(id: string, reason: string, key: string) {
    return this.call(`/payment-intents/${id}/cancel`, cancelledIntentSchema, {
      body: { reason }, key,
    });
  }
  /** Legacy payment endpoint retained only for API compatibility, never used by Checkout. */
  payment(id: string, body: unknown, key: string) {
    return this.call(`/visits/${id}/payments`, paymentSchema, { body, key });
  }
  receipt(id: string) {
    return this.call(`/receipts/${id}`, receiptSchema);
  }
  printReceipt(id: string, lang: string, key: string) {
    return this.call(`/receipts/${id}/print`, printSchema, {
      body: { lang, size: "normal" },
      key,
    });
  }
  login(body: { clinicCode: string; username: string; password: string }) {
    return this.call("/session/login", loginSchema, { body });
  }
  session() {
    return this.call("/session", sessionSchema);
  }
  logout() {
    return this.call("/session/logout", z.object({ loggedOut: z.boolean() }), {
      body: {},
    });
  }
  board(day = "", signal?: AbortSignal) {
    return this.call(
      "/day-board" + (day ? `?day=${encodeURIComponent(day)}` : ""),
      boardSchema,
      { signal },
    );
  }
  patients(q: string, signal?: AbortSignal) {
    return this.call(
      `/patients?q=${encodeURIComponent(q)}`,
      z.object({ patients: z.array(patientSchema) }),
      { signal },
    );
  }
  patient(id: string, signal?: AbortSignal) {
    return this.call(`/patients/${encodeURIComponent(id)}`, z.object({ patient: patientSchema }), { signal });
  }
  register(body: Record<string, unknown>, key: string) {
    return this.call("/patients", z.object({ patient: patientSchema }), {
      body,
      key,
    });
  }
  schedule(body: Record<string, unknown>, key: string) {
    return this.call(
      "/visits",
      z.object({
        visit: z.object({ id: z.string(), scheduledAt: z.string() }),
      }),
      { body, key },
    );
  }
  /** Owner financial controls. Server permissions remain authoritative. */
  ownerCashPeriod(signal?: AbortSignal) {
    return this.call("/cash/periods/current", ownerCashPeriodSchema, { signal });
  }
  ownerCashReview(periodId: string, signal?: AbortSignal) {
    return this.call(`/cash/periods/${periodId}/review`, cashReviewSchema, { signal });
  }
  reauthenticate(password: string) {
    return this.call("/session/reauth", z.object({
      reauthenticated: z.literal(true), validForSeconds: z.number(),
    }), { body: { password } });
  }
  openCashPeriod(openingFloatMillimes: number, key: string) {
    return this.call("/cash/periods", openCashPeriodSchema, {
      body: { openingFloatMillimes }, key,
    });
  }
  submitCashCount(periodId: string, countedMillimes: number, recountReason: string | undefined, key: string) {
    return this.call(`/cash/periods/${periodId}/counts`, submittedCashCountSchema, {
      body: { countedMillimes, ...(recountReason ? { recountReason } : {}) }, key,
    });
  }
  closeCashPeriod(periodId: string, acceptedCountId: string, handoverMillimes: number, note: string | undefined, key: string) {
    return this.call(`/cash/periods/${periodId}/close`, closedCashPeriodSchema, {
      body: { acceptedCountId, handoverMillimes, ...(note ? { note } : {}) }, key,
    });
  }
  /** Clinical detail is dentist-only; the server enforces clinical.read/write independently. */
  encounter(id: string, signal?: AbortSignal) {
    return this.call(`/visits/${id}/encounter`, encounterSchema, { signal });
  }
  signClinicalNote(id: string, sections: Record<string, unknown>, key: string) {
    return this.call(`/visits/${id}/clinical-notes`, noteCreatedSchema, {
      body: sections, key,
    });
  }
  addClinicalAddendum(noteId: string, body: Record<string, unknown>, key: string) {
    return this.call(`/clinical-notes/${noteId}/addenda`, noteCreatedSchema, {
      body, key,
    });
  }
  recordChartFinding(id: string, finding: Record<string, unknown>, key: string) {
    return this.call(`/visits/${id}/chart-findings`, findingCreatedSchema, {
      body: finding, key,
    });
  }
  addTreatmentPlanItem(patientId: string, body: Record<string, unknown>, key: string) {
    return this.call(`/patients/${patientId}/treatment-plan-items`, planItemCreatedSchema, {
      body, key,
    });
  }
  transitionTreatmentPlanItem(id: string, body: { status: "ACCEPTED" | "DECLINED" | "CANCELLED"; reason?: string }, key: string) {
    return this.call(`/treatment-plan-items/${id}/status`, planItemCreatedSchema, {
      body, key,
    });
  }
  /** Dentist-only full clinical alert set; never use the desk-safe presence summary for treatment approval. */
  medicalAlerts(patientId: string, signal?: AbortSignal) {
    return this.call(
      `/patients/${patientId}/medical-alerts`,
      z.object({
        patientId: z.string(),
        alertSetHash: z.string().regex(/^[0-9a-f]{64}$/),
        alerts: z.array(z.object({
          id: z.string(),
          code: z.string(),
          severity: z.enum(["CRITICAL", "CAUTION"]),
          detail: z.string().nullable(),
          source: z.enum(["PATIENT_DECLARED", "DENTIST_VERIFIED"]),
          status: z.enum(["ACTIVE", "RESOLVED", "ENTERED_IN_ERROR"]),
        })),
      }),
      { signal },
    );
  }
  confirmCare(id: string, body: Record<string, unknown>, key: string) {
    return this.call(
      `/visits/${id}/care`,
      z.object({
        careItem: z.object({ id: z.string(), visitId: z.string(), feeMillimes: z.number().int() }),
        visitTotalMillimes: z.number().int(),
      }),
      { body, key },
    );
  }
  arrive(id: string, key: string) {
    return this.changeVisitStatus(id, { status: "ARRIVED" }, key);
  }
  changeVisitStatus(
    id: string,
    body: { status: "ARRIVED" | "NO_SHOW" | "CANCELLED"; reason?: string },
    key: string,
  ) {
    return this.call(
      `/visits/${id}/status`,
      z.object({ visit: z.object({ id: z.string(), status: z.string() }) }),
      { body, key },
    );
  }
}
export const canWrite = (session: Session) =>
  session.staff.roles.some((r) =>
    ["OWNER", "DENTIST", "RECEPTIONIST"].includes(r),
  );

/** A write intent survives an ambiguous response with its exact body/key. No silent retry. */
export class WriteIntent {
  readonly key = crypto.randomUUID();
  private body: Record<string, unknown> | null = null;
  uncertain = false;
  payload(candidate: Record<string, unknown>) {
    if (!this.uncertain) this.body = structuredClone(candidate);
    return this.body ?? candidate;
  }
  failed(error: unknown) {
    this.uncertain =
      error instanceof ApiError &&
      (error.code === "NETWORK" || error.status >= 500);
  }
}
