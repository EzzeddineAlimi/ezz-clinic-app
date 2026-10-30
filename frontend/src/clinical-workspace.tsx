import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Api, ApiError, WriteIntent } from "./api.ts";
import type { Visit } from "./api.ts";
import type { Lang, Words } from "./i18n.ts";
import { nonemptyNote } from "./clinical-contracts.ts";
import { findingInput, planInput, statusInput } from "./clinical-input.ts";
import { FindingForm, PlanForm, PlanStatusForm } from "./clinical-action-forms.tsx";
import { clinicalText } from "./clinical-text.ts";
import { ErrorBox, Loading, Modal, useResource } from "./ui.tsx";
import { nameOf } from "./forms.tsx";
import { amount } from "./billing.ts";

type ClinicalMutation = {
  kind: "finding" | "plan" | "status" | "addendum"; targetId: string;
  body: Record<string, unknown>; key: string;
};

export function ClinicalWorkspace({ api, visit, lang, w, close }: {
  api: Api; visit: Visit; lang: Lang; w: Words; close: () => void;
}) {
  const t = clinicalText[lang];
  const chart = useResource(
    useCallback((signal: AbortSignal) => api.encounter(visit.id, signal), [api, visit.id]),
  );
  const [intent, setIntent] = useState(() => new WriteIntent());
  const [saving, setSaving] = useState(false);
  const lock = useRef(false);
  const [unresolved, setUnresolved] = useState<ClinicalMutation | null>(null);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState("");
  const [mode, setMode] = useState<"overview" | "notes" | "findings" | "plans">("overview");
  const [addendumTargetId, setAddendumTargetId] = useState<string | null>(null);
  const [signedLocally, setSignedLocally] = useState(false);
  const signedAgainst = useRef<typeof chart.data>(undefined);
  const addendumToggleRef = useRef<HTMLButtonElement>(null);
  const focusAfterAddendum = useRef<{ targetId: string; against: typeof chart.data } | null>(null);
  // Only a newly fetched authoritative chart can release the local post-sign guard.
  useEffect(() => {
    if (signedLocally && chart.data && chart.data !== signedAgainst.current &&
        !chart.data.notes.some(n => n.kind === "NOTE" && !n.enteredInError)) {
      setSignedLocally(false);
    }
  }, [chart.data, signedLocally]);
  // The toggle is disabled while saving/loading; focus only after a fresh chart has rendered.
  useEffect(() => {
    const pending = focusAfterAddendum.current;
    if (!pending) return;
    if (chart.error) { focusAfterAddendum.current = null; return; }
    if (!chart.data || chart.data === pending.against || chart.loading || saving) return;
    const eligible = chart.data.notes.some(n => n.id === pending.targetId &&
      !n.enteredInError && n.integrity !== "CONTENT_HASH_MISMATCH");
    const toggle = addendumToggleRef.current;
    if (eligible && toggle && !toggle.disabled) toggle.focus();
    focusAfterAddendum.current = null;
  }, [chart.data, chart.loading, chart.error, saving]);
  async function runClinicalWrite(
    action: ClinicalMutation, form?: HTMLFormElement,
  ): Promise<void> {
    if (lock.current || chart.loading || chart.error || !chart.data ||
        intent.uncertain || (unresolved && unresolved.key !== action.key)) return;
    lock.current = true;
    setSaving(true);
    setError(undefined);
    setNotice("");
    try {
      if (action.kind === "finding") {
        await api.recordChartFinding(action.targetId, action.body, action.key);
      } else if (action.kind === "plan") {
        await api.addTreatmentPlanItem(action.targetId, action.body, action.key);
      } else if (action.kind === "addendum") {
        await api.addClinicalAddendum(action.targetId, action.body, action.key);
      } else {
        const body = action.body as {
          status: "ACCEPTED" | "DECLINED" | "CANCELLED";
          reason?: string;
        };
        await api.transitionTreatmentPlanItem(action.targetId, body, action.key);
      }
      setUnresolved(null);
      if (action.kind === "addendum") {
        focusAfterAddendum.current = { targetId: action.targetId, against: chart.data };
        setAddendumTargetId(null);
      }
      if (form?.isConnected) form.reset();
      setNotice(lang === "fr" ? "Écriture clinique enregistrée." : "تم تسجيل التغيير السريري.");
      chart.refresh();
    } catch (cause) {
      setError(cause);
      // Unknown transport/server response is NOT failure evidence.
      // Freeze payload and idempotency key, never silently create another event.
      if (cause instanceof ApiError &&
          (cause.code === "NETWORK" || cause.code === "INVALID_RESPONSE" ||
            cause.status >= 500)) {
        setUnresolved(action);
      } else {
        setUnresolved(null);
        if (cause instanceof ApiError && cause.status === 409) chart.refresh();
      }
    } finally {
      setSaving(false);
      lock.current = false;
    }
  }

  function fromForm(
    event: FormEvent<HTMLFormElement>, kind: ClinicalMutation["kind"],
    targetId: string, makeBody: (fields: FormData) => Record<string, unknown>,
  ) {
    event.preventDefault();
    if (lock.current || saving || unresolved || intent.uncertain ||
        !chart.data || chart.error || chart.loading) return;
    const form = event.currentTarget;
    let body: Record<string, unknown>;
    try { body = makeBody(new FormData(form)); }
    catch (cause) { setError(cause); return; }
    const action: ClinicalMutation = { kind, targetId, body, key: crypto.randomUUID() };
    void runClinicalWrite(action, form);
  }

  async function sign(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (saving || lock.current || unresolved || chart.loading || !chart.data || chart.error) return;
    const form = e.currentTarget;
    let body: Record<string, unknown> = {};
    if (!intent.uncertain) {
      const fields = new FormData(form);
      const values = {
        subjective: String(fields.get("subjective") ?? "").trim(),
        objective: String(fields.get("objective") ?? "").trim(),
        assessment: String(fields.get("assessment") ?? "").trim(),
        plan: String(fields.get("plan") ?? "").trim(),
      };
      if (!nonemptyNote(values)) { setError(new ApiError("VALIDATION_FAILED")); return; }
      body = Object.fromEntries(Object.entries(values).filter(([, value]) => value.length > 0));
    }
    lock.current = true;
    setSaving(true);
    setError(undefined);
    try {
      await api.signClinicalNote(visit.id, intent.payload(body), intent.key);
      signedAgainst.current = chart.data;
      setSignedLocally(true); // A successful write must never expose another initial-sign action while refreshing.
      setIntent(new WriteIntent());
      setNotice(lang === "fr" ? "Note signée et enregistrée." : "تم توقيع وتسجيل الملاحظة.");
      form.reset();
      chart.refresh();
    } catch (cause) {
      intent.failed(cause);
      if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500) {
        setIntent(new WriteIntent());
      }
      setError(cause);
    } finally { setSaving(false); lock.current = false; }
  }
  const data = chart.data;
  const initialNoteSigned = signedLocally || !!data?.notes.some(n => n.kind === "NOTE" && !n.enteredInError);
  const soapSections = ["subjective", "objective", "assessment", "plan"] as const;
  const soapLabels = { subjective: t.subjective, objective: t.objective,
    assessment: t.assessment, plan: t.planSection };
  const editable = !!data && !chart.loading && !chart.error && !saving && !unresolved &&
    !["CANCELLED", "NO_SHOW"].includes(data.visit.status);
  return (
    <Modal title={t.title} busy={saving} w={w} close={close}>
      <section className="clinical-workspace">
        <div className="patient-context">
          <strong><bdi>{nameOf(visit.patient)}</bdi> · #{visit.patient.fileNo}</strong>
        </div>
        <p className="warning">{t.fictional}</p>
        {chart.loading && <Loading label={w.loading} />}
        {chart.error !== undefined && <ErrorBox error={chart.error} w={w} />}
        {error !== undefined && <ErrorBox error={error} w={w} />}
        {notice && <p role="status" className="toast">{notice}</p>}
        {intent.uncertain && <p role="alert" className="uncertain">{t.uncertain}</p>}
        {unresolved && <section role="alert" className="uncertain">
          <p>{t.uncertain}</p>
          <button className="secondary" type="button" disabled={saving || chart.loading || !!chart.error}
            onClick={() => void runClinicalWrite(unresolved)}>{t.retry}</button>
        </section>}
        <button type="button" className="secondary" disabled={saving}
          onClick={() => chart.refresh()}>{t.refresh}</button>
        {data && (
          <>
            {data.medical.activeAlerts.length > 0 &&
              <p className="warning" role="alert">{t.warning} · {data.medical.activeAlerts.length}</p>}
            <nav className="clinical-nav" aria-label={t.title}>
              <button type="button" aria-pressed={mode === "overview"} onClick={() => setMode("overview")}>{t.overview}</button>
              <button type="button" aria-pressed={mode === "notes"} onClick={() => setMode("notes")}>{t.note} ({data.notes.length})</button>
              <button type="button" aria-pressed={mode === "findings"} onClick={() => setMode("findings")}>{t.findings} ({data.findings.length})</button>
              <button type="button" aria-pressed={mode === "plans"} onClick={() => setMode("plans")}>{t.plan} ({data.planItems.length})</button>
            </nav>
            {mode === "overview" && (
              <section className="clinical-entry" data-testid="clinical-overview">
                <h3>{t.overview}</h3>
                <p><strong>{t.visitStatus}:</strong> {t.visitStatuses[data.visit.status as keyof typeof t.visitStatuses] ?? data.visit.status}</p>
                <p><strong>{t.assignedDentist}:</strong> <bdi>{visit.dentist?.name ?? t.unassigned}</bdi></p>
                <p><strong>{t.medicalAlerts}:</strong> <bdi>{data.medical.activeAlerts.length}</bdi></p>
                {data.medical.activeAlerts.length > 0 && (
                  <ul data-testid="clinical-alert-details">
                    {data.medical.activeAlerts.map(alert => (
                      <li key={alert.id}>
                        <strong><bdi>{alert.code}</bdi></strong>
                        {" · "}{alert.severity === "CRITICAL" ? t.alertCritical : t.alertCaution}
                        {" · "}{alert.source === "PATIENT_DECLARED" ? t.alertDeclared : t.alertVerified}
                        {alert.detail && <p><bdi>{alert.detail}</bdi></p>}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="warning">{t.overviewHint}</p>
              </section>
            )}
            {mode === "notes" && <>
              {data.notes.length === 0 && !initialNoteSigned && <p>{t.empty}</p>}
              {data.notes.map(n => (
                <article className="clinical-entry" key={n.id}>
                  <strong>{t.noteKinds[n.kind]} · <bdi>{n.signedByName}</bdi></strong>
                  <small>{t.signedStatus} · <bdi>{n.signedAt}</bdi></small>
                  {n.integrity === "CONTENT_HASH_MISMATCH" && <p role="alert" className="error-box">{t.warning}</p>}
                  {n.enteredInError && <p className="warning">{t.struck}: <bdi>{n.enteredInError.reason}</bdi></p>}
                  {soapSections.map(k =>
                    n[k] && <p key={k}><strong>{soapLabels[k]}:</strong> <bdi>{n[k]}</bdi></p>)}
                  {(n.kind === "NOTE" || n.kind === "LATE_ENTRY") &&
                    !n.enteredInError && n.integrity !== "CONTENT_HASH_MISMATCH" && (
                    <button type="button" className="secondary" disabled={!editable || intent.uncertain}
                      ref={addendumTargetId === n.id || focusAfterAddendum.current?.targetId === n.id
                        ? addendumToggleRef : undefined}
                      aria-expanded={addendumTargetId === n.id}
                      onClick={() => {
                        if (focusAfterAddendum.current?.targetId !== n.id) focusAfterAddendum.current = null;
                        setAddendumTargetId(addendumTargetId === n.id ? null : n.id);
                      }}>
                      {t.addendum}
                    </button>
                  )}
                  {addendumTargetId === n.id && (
                    <form data-testid="clinical-addendum-form" className="cash-form"
                      onSubmit={e => fromForm(e, "addendum", n.id, fields => {
                        const sections = Object.fromEntries(soapSections.map(k =>
                          [k, String(fields.get(k) ?? "").trim()])) as Record<typeof soapSections[number], string>;
                        if (!nonemptyNote(sections)) throw new ApiError("VALIDATION_FAILED");
                        const reason = String(fields.get("reason") ?? "").trim();
                        return { kind: "ADDENDUM", ...sections, ...(reason ? { reason } : {}) };
                      })}>
                      <p className="muted">{t.addendumHint}</p>
                      <fieldset disabled={!editable || intent.uncertain}>
                        {soapSections.map(k => (
                          <label key={k}>{soapLabels[k]}<textarea name={k} maxLength={4000} rows={2} /></label>
                        ))}
                        <label>{t.reason}<input name="reason" maxLength={300} /></label>
                      </fieldset>
                      <button className="primary" type="submit" disabled={!editable || intent.uncertain}>
                        {saving ? t.saving : t.signAddendum}
                      </button>
                    </form>
                  )}
                </article>
              ))}
              {initialNoteSigned ? <p role="status" className="muted">{t.initialSigned}</p> : (
                <form data-testid="clinical-initial-note-form" className="cash-form" onSubmit={e => void sign(e)}>
                  <fieldset disabled={!editable || intent.uncertain}>
                    {soapSections.map(k => (
                      <label key={k}>{soapLabels[k]}<textarea name={k} maxLength={4000} rows={2} /></label>
                    ))}
                  </fieldset>
                  <button className="primary" type="submit" disabled={!editable}>
                    {saving ? t.saving : intent.uncertain ? t.retry : t.sign}
                  </button>
                </form>
              )}
            </>}
            {mode === "findings" && <>
              {data.findings.length === 0 && <p>{t.empty}</p>}
              {data.findings.map(f => <article className="clinical-entry" key={f.id} data-struck={!!f.enteredInError}>
                <strong>{f.enteredInError
                  ? <s>{f.kind} · {f.conditionCode}</s>
                  : <>{f.kind} · {f.conditionCode}</>}</strong>
                <p>{t.tooth}: {f.toothFdi ?? f.areaCode ?? "—"}</p>
                {f.enteredInError && <p role="alert" className="warning" data-testid="struck-finding">
                  {lang === "fr" ? "Constatation signalée comme erronée : " : "تم تصنيف الملاحظة كإدخال خاطئ: "}
                  <bdi>{f.enteredInError.reason}</bdi>
                </p>}
                {f.note && <p><bdi>{f.note}</bdi></p>}
              </article>)}
              <FindingForm lang={lang} disabled={!editable || intent.uncertain}
                submit={event => fromForm(event, "finding", visit.id, findingInput)} />
            </>}
            {mode === "plans" && <>
              <p className="warning">{t.quote}</p>
              {data.planItems.length === 0 && <p>{t.empty}</p>}
              {data.planItems.map(p => <article className="clinical-entry" key={p.id}>
                <strong><bdi>{p.procedureCode} · {p.procedureLabel}</bdi></strong>
                <p>{t.tooth}: {p.toothFdi ?? "—"} · <span data-testid="plan-status">{t.planStatuses[p.status]}</span></p>
                <p>{t.planEstimate}: <bdi>{p.estimatedFeeMillimes === null ? "—" : amount(p.estimatedFeeMillimes)}</bdi></p>
                {(p.status === "PROPOSED" || p.status === "ACCEPTED") && (
                  <PlanStatusForm lang={lang} status={p.status}
                    disabled={!editable || intent.uncertain}
                    submit={event => fromForm(event, "status", p.id, fields => {
                      const status = String(fields.get("status") ?? "");
                      if (!["ACCEPTED", "DECLINED", "CANCELLED"].includes(status))
                        throw new ApiError("VALIDATION_FAILED", 400);
                      return statusInput(
                        status as "ACCEPTED" | "DECLINED" | "CANCELLED",
                        String(fields.get("reason") ?? ""),
                      );
                    })} />
                )}
              </article>)}
              <PlanForm lang={lang} disabled={!editable || intent.uncertain}
                submit={event => fromForm(event, "plan", visit.patient.id,
                  fields => planInput(fields, visit.id))} />
            </>}
          </>
        )}
      </section>
    </Modal>
  );
}
