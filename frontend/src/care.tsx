import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Api, ApiError, WriteIntent } from "./api.ts";
import type { Visit } from "./api.ts";
import type { Words } from "./i18n.ts";
import { ErrorBox, Loading, Modal, useResource } from "./ui.tsx";
import { nameOf } from "./forms.tsx";

/** Exact three-decimal Tunisian dinars; this path also supports zero-fee care with a reason. */
export function tndMillimes(text: string): number {
  const match = /^(0|[1-9][0-9]{0,5})(?:[.,]([0-9]{1,3}))?$/.exec(text.trim());
  if (!match) throw new ApiError("VALIDATION_FAILED");
  const value = Number(match[1]) * 1000 + Number((match[2] ?? "").padEnd(3, "0"));
  if (!Number.isSafeInteger(value) || value > 100_000_000)
    throw new ApiError("VALIDATION_FAILED");
  return value;
}

/** A dentist must SEE the current full medical-alert set before accepting its hash.
 * Server independently binds the hash to the active immutable alert revisions and refuses stale values.
 * One explicit checkbox is integrated in the existing care modal: no separate confirmation screen.
 */
export function CareConfirmation({
  api, visit, w, close, saved, uncertainClose,
}: {
  api: Api;
  visit: Visit;
  w: Words;
  close: () => void;
  saved: () => void;
  uncertainClose: () => void;
}) {
  const alerts = useResource(
    useCallback((signal: AbortSignal) => api.medicalAlerts(visit.patient.id, signal),
      [api, visit.patient.id]),
  );
  const [intent, setIntent] = useState(() => new WriteIntent());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [reviewedHash, setReviewedHash] = useState<string | null>(null);
  const [repeatRequired, setRepeatRequired] = useState(false);
  const [repeatConfirmed, setRepeatConfirmed] = useState(false);
  useEffect(() => setReviewedHash(null), [alerts.data?.alertSetHash]);
  const activeAlerts = alerts.data?.alerts.filter(a => a.status === "ACTIVE") ?? [];
  const alertReviewed = !!alerts.data &&
    (activeAlerts.length === 0 || reviewedHash === alerts.data.alertSetHash);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    let body: Record<string, unknown>;
    try {
      if (intent.uncertain) {
        body = intent.payload({});
      } else {
        if (!alerts.data || !alertReviewed) throw new ApiError("MEDICAL_ALERTS_NOT_ACKNOWLEDGED");
        if (repeatRequired && !repeatConfirmed) throw new ApiError("CARE_ALREADY_CONFIRMED");
        const fields = new FormData(e.currentTarget);
        const procedureCode = String(fields.get("procedureCode") ?? "").trim().toUpperCase();
        const procedureLabel = String(fields.get("procedureLabel") ?? "").trim();
        const feeMillimes = tndMillimes(String(fields.get("feeTnd") ?? ""));
        const tooth = String(fields.get("toothFdi") ?? "").trim();
        const surfaces = String(fields.get("surfaces") ?? "").trim().toUpperCase();
        const reason = String(fields.get("reason") ?? "").trim();
        if (feeMillimes === 0 && reason.length < 3)
          throw new ApiError("VALIDATION_FAILED");
        body = {
          procedureCode, procedureLabel, feeMillimes,
          ...(tooth ? { toothFdi: Number(tooth) } : {}),
          ...(surfaces ? { surfaces } : {}),
          ...(reason ? { reason } : {}),
          ...(activeAlerts.length ? { alertSetHash: alerts.data.alertSetHash } : {}),
          ...(repeatRequired && repeatConfirmed ? { confirmRepeat: true } : {}),
        };
      }
    } catch (cause) {
      setError(cause);
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      await api.confirmCare(visit.id, intent.payload(body), intent.key);
      saved();
    } catch (cause) {
      intent.failed(cause);
      if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500) {
        // A completed server denial rolls the attempted write back. New body => new key.
        setIntent(new WriteIntent());
      }
      if (cause instanceof ApiError && cause.code === "CARE_ALREADY_CONFIRMED") {
        setRepeatRequired(true);
        setRepeatConfirmed(false);
      }
      if (cause instanceof ApiError && cause.code === "MEDICAL_ALERTS_CHANGED") {
        setReviewedHash(null);
        alerts.refresh();
      }
      setError(cause);
    } finally {
      setPending(false);
    }
  }
  const exit = () => {
    if (intent.uncertain) uncertainClose();
    close();
  };
  return (
    <Modal title={w.careTitle} w={w} busy={pending} close={exit}>
      <form onSubmit={(e) => void submit(e)}>
        <div className="patient-context">
          <span className="avatar">{visit.patient.givenName.slice(0, 1)}</span>
          <div>
            <small>{w.selectedPatient}</small>
            <strong><bdi>{nameOf(visit.patient)}</bdi> · <bdi>#{visit.patient.fileNo}</bdi></strong>
          </div>
        </div>
        <p className="muted">{w.careHint}</p>
        {error !== undefined && <ErrorBox error={error} w={w} />}
        {intent.uncertain && <p className="uncertain" role="alert">{w.uncertain}</p>}
        <section className="care-alert-review" aria-label={w.careAlertTitle}>
          <strong>{w.careAlertTitle}</strong>
          {alerts.loading && <Loading label={w.loading} />}
          {alerts.error !== undefined && <ErrorBox error={alerts.error} w={w} />}
          {alerts.data && (
            <>
              {activeAlerts.length === 0
                ? <p>{w.careNoAlerts}</p>
                : <>
                    <p role="alert">{w.careAlertCount}: {activeAlerts.length}. {w.careAlertExplanation}</p>
                    <ul>
                      {activeAlerts.map(a => (
                        <li key={a.id}>
                          <strong><bdi>{a.code}</bdi></strong> · {a.severity === "CRITICAL" ? w.careAlertCritical : w.careAlertCaution}
                          {" "}· {a.source === "PATIENT_DECLARED" ? w.carePatientDeclared : w.careDentistVerified}
                          {a.detail && <p><bdi>{a.detail}</bdi></p>}
                        </li>
                      ))}
                    </ul>
                    <label>
                      <input type="checkbox" checked={reviewedHash === alerts.data.alertSetHash}
                        disabled={pending || intent.uncertain}
                        onChange={e => setReviewedHash(e.target.checked ? alerts.data!.alertSetHash : null)} />
                      {w.careAcknowledgeAlerts}
                    </label>
                  </>
              }
              <button type="button" className="secondary compact" disabled={pending || intent.uncertain}
                onClick={() => { setReviewedHash(null); alerts.refresh(); }}>
                {w.refresh}
              </button>
            </>
          )}
        </section>
        <fieldset disabled={pending || intent.uncertain || !alertReviewed} className="form-grid">
          <label>
            {w.careCode} *
            <input name="procedureCode" required minLength={2} maxLength={32}
              pattern="[A-Za-z0-9_.-]{2,32}" autoComplete="off" />
          </label>
          <label>
            {w.careFee} *
            <input name="feeTnd" type="text" inputMode="decimal" dir="ltr"
              required pattern="(0|[1-9][0-9]{0,5})([.,][0-9]{1,3})?" placeholder="100.000"
              autoComplete="off" />
          </label>
          <label className="span-2">
            {w.careLabel} *
            <input name="procedureLabel" required minLength={2} maxLength={160} autoComplete="off" />
          </label>
          <label>
            {w.careTooth}
            <input name="toothFdi" type="number" min={11} max={85} step={1} />
          </label>
          <label>
            {w.careSurfaces}
            <input name="surfaces" pattern="[MmOoDdBbLlIiFfPp]{1,7}" maxLength={7} autoComplete="off" />
          </label>
          <label className="span-2">
            {w.careReason}
            <input name="reason" maxLength={300} autoComplete="off" />
          </label>
        </fieldset>
        {repeatRequired && <div className="uncertain" role="group" aria-label={w.careRepeatTitle}>
          <strong>{w.careRepeatTitle}</strong>
          <label>
            <input type="checkbox" checked={repeatConfirmed}
              disabled={pending || intent.uncertain}
              onChange={e => { setRepeatConfirmed(e.target.checked); setError(undefined); }} />
            {w.careRepeatConfirm}
          </label>
        </div>}
        <footer className="form-footer">
          <button type="button" className="secondary" disabled={pending} onClick={exit}>{w.cancel}</button>
          <button className="primary" disabled={pending || (!intent.uncertain && (!alertReviewed || (repeatRequired && !repeatConfirmed)))}>
            {pending ? w.saving : intent.uncertain ? w.retry : w.confirmCare}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
