import { useState } from "react";
import type { FormEvent } from "react";
import { Api, WriteIntent } from "./api.ts";
import type { Visit } from "./api.ts";
import type { Words } from "./i18n.ts";
import { nameOf } from "./forms.tsx";
import { ErrorBox, Modal } from "./ui.tsx";

type DeskStatus = "NO_SHOW" | "CANCELLED";

/** A separate idempotent write per proposed transition; uncertain retries keep the exact body and key. */
export function VisitStatusModal({
  api,
  visit,
  status,
  w,
  close,
  saved,
  uncertainClose,
}: {
  api: Api;
  visit: Visit;
  status: DeskStatus;
  w: Words;
  close: () => void;
  saved: () => void;
  uncertainClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [intent] = useState(() => new WriteIntent());

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (reason.trim().length < 3) return;
    setPending(true);
    setError(undefined);
    try {
      const body = intent.payload({ status, reason: reason.trim() });
      await api.changeVisitStatus(visit.id, body as { status: DeskStatus; reason: string }, intent.key);
      saved();
    } catch (err) {
      intent.failed(err);
      setError(err);
    } finally {
      setPending(false);
    }
  }
  function exit() {
    if (intent.uncertain) uncertainClose();
    close();
  }
  return (
    <Modal
      title={status === "NO_SHOW" ? w.markNoShow : w.cancelVisit}
      w={w}
      busy={pending}
      close={exit}
    >
      <form className="visit-status-form" onSubmit={(event) => void submit(event)}>
        <div className="patient-context">
          <strong><bdi>{nameOf(visit.patient)}</bdi> · {w.file} <bdi>#{visit.patient.fileNo}</bdi></strong>
          <p><bdi>{visit.localTime}</bdi> · {w[visit.status]} → {w[status]}</p>
        </div>
        <label htmlFor="visit-status-reason">{w.visitReason} *</label>
        <textarea
          id="visit-status-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          required
          minLength={3}
          maxLength={200}
          rows={3}
          disabled={pending || intent.uncertain}
        />
        <p className="muted">{w.reasonHint}</p>
        {error !== undefined && <ErrorBox error={error} w={w} />}
        {intent.uncertain && <p role="alert" className="uncertain">{w.uncertain}</p>}
        <div className="form-footer">
          <button type="button" className="secondary" disabled={pending} onClick={exit}>{w.cancel}</button>
          <button type="submit" className="primary" disabled={pending || reason.trim().length < 3}>
            {pending ? w.saving : intent.uncertain ? w.retry : w.confirmStatus}
          </button>
        </div>
      </form>
    </Modal>
  );
}
