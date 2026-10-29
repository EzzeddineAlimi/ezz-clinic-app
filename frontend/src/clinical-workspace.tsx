import { useCallback, useState } from "react";
import type { FormEvent } from "react";
import { Api, ApiError, WriteIntent } from "./api.ts";
import type { Visit } from "./api.ts";
import type { Lang, Words } from "./i18n.ts";
import { nonemptyNote } from "./clinical-contracts.ts";
import { clinicalText } from "./clinical-text.ts";
import { ErrorBox, Loading, Modal, useResource } from "./ui.tsx";
import { nameOf } from "./forms.tsx";
import { amount } from "./billing.ts";

export function ClinicalWorkspace({ api, visit, lang, w, close }: {
  api: Api; visit: Visit; lang: Lang; w: Words; close: () => void;
}) {
  const t = clinicalText[lang];
  const chart = useResource(
    useCallback((signal: AbortSignal) => api.encounter(visit.id, signal), [api, visit.id]),
  );
  const [intent, setIntent] = useState(() => new WriteIntent());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState("");
  const [mode, setMode] = useState<"notes" | "findings" | "plans">("notes");
  async function sign(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (saving || chart.loading || !chart.data || chart.error) return;
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
    setSaving(true);
    setError(undefined);
    try {
      await api.signClinicalNote(visit.id, intent.payload(body), intent.key);
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
    } finally { setSaving(false); }
  }
  const data = chart.data;
  const editable = !!data && !chart.loading && !chart.error && !saving &&
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
        <button type="button" className="secondary" disabled={saving}
          onClick={() => chart.refresh()}>{t.refresh}</button>
        {data && (
          <>
            {data.medical.activeAlerts.length > 0 &&
              <p className="warning" role="alert">{t.warning} · {data.medical.activeAlerts.length}</p>}
            <nav className="clinical-nav" aria-label={t.title}>
              <button type="button" aria-pressed={mode === "notes"} onClick={() => setMode("notes")}>{t.note} ({data.notes.length})</button>
              <button type="button" aria-pressed={mode === "findings"} onClick={() => setMode("findings")}>{t.findings} ({data.findings.length})</button>
              <button type="button" aria-pressed={mode === "plans"} onClick={() => setMode("plans")}>{t.plan} ({data.planItems.length})</button>
            </nav>
            {mode === "notes" && <>
              {data.notes.length === 0 && <p>{t.empty}</p>}
              {data.notes.map(n => (
                <article className="clinical-entry" key={n.id}>
                  <strong>{n.kind} · <bdi>{n.signedByName}</bdi></strong>
                  <small><bdi>{n.signedAt}</bdi></small>
                  {n.integrity === "CONTENT_HASH_MISMATCH" && <p role="alert" className="error-box">{t.warning}</p>}
                  {n.enteredInError && <p className="warning">{n.enteredInError.reason}</p>}
                  {(["subjective","objective","assessment","plan"] as const).map(k =>
                    n[k] && <p key={k}><bdi>{n[k]}</bdi></p>)}
                </article>
              ))}
              <form className="cash-form" onSubmit={e => void sign(e)}>
                <fieldset disabled={!editable || intent.uncertain}>
                  {(["subjective","objective","assessment","plan"] as const).map(k => (
                    <label key={k}>{k}<textarea name={k} maxLength={4000} rows={2} /></label>
                  ))}
                </fieldset>
                <button className="primary" type="submit" disabled={!editable}>
                  {saving ? t.saving : intent.uncertain ? t.retry : t.sign}
                </button>
              </form>
            </>}
            {mode === "findings" && <>
              {data.findings.length === 0 && <p>{t.empty}</p>}
              {data.findings.map(f => <article className="clinical-entry" key={f.id}>
                <strong>{f.kind} · {f.conditionCode}</strong>
                <p>{t.tooth}: {f.toothFdi ?? f.areaCode ?? "—"}</p>
                {f.note && <p><bdi>{f.note}</bdi></p>}
              </article>)}
            </>}
            {mode === "plans" && <>
              <p className="warning">{t.quote}</p>
              {data.planItems.length === 0 && <p>{t.empty}</p>}
              {data.planItems.map(p => <article className="clinical-entry" key={p.id}>
                <strong><bdi>{p.procedureCode} · {p.procedureLabel}</bdi></strong>
                <p>{t.tooth}: {p.toothFdi ?? "—"} · {p.status}</p>
                <p>{p.estimatedFeeMillimes === null ? "—" : amount(p.estimatedFeeMillimes)}</p>
              </article>)}
            </>}
          </>
        )}
      </section>
    </Modal>
  );
}
