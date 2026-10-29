import { z } from "zod";

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
        credentials: "omit",
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
  arrive(id: string, key: string) {
    return this.call(
      `/visits/${id}/status`,
      z.object({ visit: z.object({ id: z.string(), status: z.string() }) }),
      { body: { status: "ARRIVED" }, key },
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
    this.uncertain = error instanceof ApiError && error.code === "NETWORK";
  }
}
