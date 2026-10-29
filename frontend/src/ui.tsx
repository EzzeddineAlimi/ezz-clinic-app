import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ApiError } from "./api.ts";
import type { Lang, Words } from "./i18n.ts";

export function Icon({
  name,
  size = 20,
}: {
  name:
    | "calendar"
    | "people"
    | "plus"
    | "search"
    | "arrow"
    | "check"
    | "logout"
    | "close";
  size?: number;
}) {
  const paths = {
    calendar:
      "M8 2v4m8-4v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z",
    people:
      "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m18 0v-2a4 4 0 0 0-3-3.87M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm8-7.87a4 4 0 0 1 0 7.75",
    plus: "M12 5v14M5 12h14",
    search: "m21 21-5-5M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z",
    arrow: "m9 5 7 7-7 7",
    check: "m5 12 4 4L19 6",
    logout: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m7 14 5-5-5-5m-7 5h12",
    close: "m6 6 12 12M6 18 18 6",
  };
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[name]} />
    </svg>
  );
}
export function Brand() {
  return (
    <div className="brand" dir="ltr">
      <span className="brand-symbol">e</span>
      <span>
        ezz<span className="brand-sub">CLINIC</span>
      </span>
    </div>
  );
}
export function useResource<T>(load: (signal: AbortSignal) => Promise<T>) {
  const [state, setState] = useState<{
    data?: T;
    error?: unknown;
    loading: boolean;
  }>({ loading: true });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setState({ loading: true });
    void load(abort.signal).then(
      (data) => {
        if (!abort.signal.aborted) setState({ data, loading: false });
      },
      (error) => {
        if (!abort.signal.aborted) setState({ error, loading: false });
      },
    );
    return () => abort.abort();
  }, [load, revision]);
  return { ...state, refresh: () => setRevision((r) => r + 1) };
}
export function errorText(error: unknown, w: Words) {
  if (!(error instanceof ApiError)) return w.generic;
  const messages: Record<string, string> = {
    NETWORK: w.network,
    INVALID_RESPONSE: w.response,
    UNAUTHENTICATED: w.credentials,
    ACCOUNT_LOCKED: w.locked,
    FORBIDDEN_ROLE: w.permission,
    NOT_FOUND: w.notFound,
    VALIDATION_FAILED: w.invalid,
    CONFLICT: w.conflict,
    REAUTH_REQUIRED: w.reauth,
    IDEMPOTENCY_KEY_REUSED: w.conflict,
    CARE_ALREADY_CONFIRMED: w.careDuplicate,
    MEDICAL_ALERTS_NOT_ACKNOWLEDGED: w.careAlerts,
    MEDICAL_ALERTS_CHANGED: w.careAlerts,
  };
  return messages[error.code] ?? w.generic;
}
export function ErrorBox({
  error,
  w,
  children,
}: {
  error: unknown;
  w: Words;
  children?: ReactNode;
}) {
  const fieldLabels: Record<string, string> = {
    familyName: w.familyName,
    givenName: w.givenName,
    phone: w.phone,
    dateOfBirth: w.dob,
    nameAr: w.nameAr,
    durationMin: w.duration,
    scheduledAt: w.time,
    dentistId: w.dentist,
  };
  return (
    <div className="error-box" role="alert">
      <strong>{errorText(error, w)}</strong>
      {error instanceof ApiError &&
        typeof error.details.field === "string" &&
        fieldLabels[error.details.field] && (
          <p>
            <bdi>{fieldLabels[error.details.field]}</bdi>
          </p>
        )}
      {error instanceof ApiError && error.requestId && (
        <p>
          {w.support}: <bdi>{error.requestId}</bdi>
        </p>
      )}
      {children}
    </div>
  );
}
export function Loading({ label }: { label: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" />
      {label}
    </div>
  );
}
export function Empty({
  title,
  text,
  action,
}: {
  title: string;
  text: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name="calendar" size={30} />
      </span>
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}
export function Modal({
  title,
  w,
  busy,
  close,
  children,
}: {
  title: string;
  w: Words;
  busy: boolean;
  close: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    d.showModal();
    return () => {
      d.close();
      queueMicrotask(() => {
        if (opener?.isConnected) opener.focus();
        else document.querySelector<HTMLElement>("#main")?.focus();
      });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby="dialog-title"
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const elements = [
          ...event.currentTarget.querySelectorAll<HTMLElement>(
            "button, input, select, textarea, a[href], [tabindex]",
          ),
        ].filter(
          (el) =>
            el.tabIndex >= 0 &&
            !el.matches(":disabled") &&
            el.getClientRects().length > 0,
        );
        const first = elements[0],
          last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) close();
      }}
    >
      <div className="modal-head">
        <div>
          <p className="eyebrow">EZZ CLINIC</p>
          <h2 id="dialog-title">{title}</h2>
        </div>
        <button
          className="icon-button"
          aria-label={w.close}
          disabled={busy}
          onClick={close}
        >
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  );
}

export function Language({
  lang,
  setLang,
  w,
}: {
  lang: Lang;
  setLang: (lang: Lang) => void;
  w: Words;
}) {
  return (
    <div className="language" role="group" aria-label={w.language}>
      <button
        lang="fr"
        aria-pressed={lang === "fr"}
        onClick={() => setLang("fr")}
      >
        FR
      </button>
      <button
        lang="ar"
        aria-pressed={lang === "ar"}
        onClick={() => setLang("ar")}
      >
        العربية
      </button>
    </div>
  );
}
