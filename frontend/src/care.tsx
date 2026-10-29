import { useState } from "react";
import type { FormEvent } from "react";
import { Api, ApiError, WriteIntent } from "./api.ts";
import type { Visit } from "./api.ts";
import type { Words } from "./i18n.ts";
import { ErrorBox, Modal } from "./ui.tsx";
import { nameOf } from "./forms.tsx";

/** Convert exact TND decimal text to integer millimes; never round floating-point money. */
export function tndMillimes(text: string): number {
  const match = /^(0|[1-9][0-9]{0,5})(?:[.,]([0-9]{1,3}))?$/.exec(text.trim());
  if (!match) throw new ApiError("VALIDATION_FAILED");
  const value = Number(match[1]) * 1000 + Number((match[2] ?? "").padEnd(3, "0"));
  if (!Number.isSafeInteger(value) || value > 100_000_000)
    throw new ApiError("VALIDATION_FAILED");
  return value;
}

/** One dentist-authored care confirmation. No reception/owner impersonation or extra approval screen. */
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
  const [intent] = useState(() => new WriteIntent());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    let body: Record<string, unknown>;
    try {
      if (intent.uncertain) {
        body = intent.payload({});
      } else {
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
        <fieldset disabled={pending || intent.uncertain} className="form-grid">
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
        <footer className="form-footer">
          <button type="button" className="secondary" disabled={pending} onClick={exit}>{w.cancel}</button>
          <button className="primary" disabled={pending}>{pending ? w.saving : intent.uncertain ? w.retry : w.confirmCare}</button>
        </footer>
      </form>
    </Modal>
  );
}
