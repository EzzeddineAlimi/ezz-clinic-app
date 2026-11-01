import { useCallback, useState } from "react";
import type { FormEvent } from "react";
import { Api, ApiError, WriteIntent } from "./api.ts";
import type { Board, Patient } from "./api.ts";
import type { Words } from "./i18n.ts";
import { clinicInstant } from "./time.ts";
import { ErrorBox, Loading, Modal, useResource } from "./ui.tsx";

export function nameOf(p: Patient) {
  return `${p.givenName} ${p.familyName}`;
}
/** Fetch a selected record only after a duplicate-name prompt, never a bulk list of full birth dates. */
export function usePatientVerification(api: Api) {
  const [selected, setSelected] = useState<Patient>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  async function open(summary: Pick<Patient, "id">) {
    setBusy(true);
    setError(undefined);
    setSelected(undefined);
    try {
      const { patient } = await api.patient(summary.id);
      setSelected({
        ...patient,
        phoneLast4: patient.phone ? patient.phone.replace(/[^0-9]/g, "").slice(-4) : null,
      });
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }
  return { selected, setSelected, busy, error, open };
}
export function PatientPicker({
  api,
  w,
  select,
}: {
  api: Api;
  w: Words;
  select: (patient: Patient) => void;
}) {
  const [query, setQuery] = useState(""),
    [search, setSearch] = useState("");
  const {
    selected: verifyPatient, setSelected: setVerifyPatient,
    busy: verificationPending, error: verificationError, open: openVerification,
  } = usePatientVerification(api);
  const resource = useResource(
    useCallback(
      (signal: AbortSignal) => api.patients(search, signal),
      [api, search],
    ),
  );
  return (
    <div className="picker">
      <label htmlFor="picker-search">{w.choosePatient}</label>
      <div className="search-row">
        <input
          id="picker-search"
          type="search"
          maxLength={80}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={w.searchLabel}
        />
        <button
          type="button"
          className="secondary"
          onClick={() => setSearch(query.trim())}
        >
          {w.search}
        </button>
      </div>
      {resource.loading ? (
        <Loading label={w.loading} />
      ) : resource.error ? (
        <ErrorBox error={resource.error} w={w} />
      ) : (
        <div className="picker-results">
          {resource.data?.patients.length === 0 && <p>{w.noPatients}</p>}
          {resource.data?.patients.map((p) => (
            <button type="button" key={p.id} disabled={verificationPending}
              onClick={() => p.hasSameNameInClinic ? void openVerification(p) : select(p)}>
              <bdi>{nameOf(p)}</bdi>
              <span>{w.file} <bdi>#{p.fileNo}</bdi></span>
              {(p.birthYear || p.phoneLast4) && <small>
                {p.birthYear && <span>{w.birthYear}: <bdi>{p.birthYear}</bdi></span>}
                {p.phoneLast4 && <span> · {w.phoneEnding} <bdi>••••{p.phoneLast4}</bdi></span>}
              </small>}
            </button>
          ))}
        </div>
      )}
      {verificationPending && <Loading label={w.loading} />}
      {verificationError !== undefined && <ErrorBox error={verificationError} w={w} />}
      {verifyPatient && (
        <Modal title={w.patientSafety} w={w} busy={false} close={() => setVerifyPatient(undefined)}>
          <p role="alert">{w.identityCheck}</p>
          <div className="patient-context">
            <strong><bdi>{nameOf(verifyPatient)}</bdi> · {w.file} <bdi>#{verifyPatient.fileNo}</bdi></strong>
            {verifyPatient.dateOfBirth && <p>{w.dob}: <bdi>{verifyPatient.dateOfBirth.split("-").reverse().join("/")}</bdi></p>}
            {verifyPatient.phoneLast4 && <p>{w.phoneEnding} <bdi>••••{verifyPatient.phoneLast4}</bdi></p>}
          </div>
          <div className="form-footer">
            <button type="button" className="secondary" onClick={() => setVerifyPatient(undefined)}>{w.cancel}</button>
            <button type="button" className="primary" onClick={() => {
              const confirmed = verifyPatient;
              setVerifyPatient(undefined);
              select(confirmed);
            }}>{w.confirmFile} · #{verifyPatient.fileNo}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

type DuplicateCandidate = { id: string; fileNo: number };

export function Registration({
  api,
  w,
  close,
  saved,
  existing,
  uncertainClose,
}: {
  api: Api;
  w: Words;
  close: () => void;
  saved: (p: Patient) => void;
  existing: (p: Patient) => void;
  uncertainClose: () => void;
}) {
  const [intent] = useState(() => new WriteIntent()),
    [pending, setPending] = useState(false),
    [error, setError] = useState<unknown>(),
    [duplicate, setDuplicate] = useState(false),
    [confirmed, setConfirmed] = useState(false),
    [contact, setContact] = useState("IN_PERSON"),
    [candidates, setCandidates] = useState<DuplicateCandidate[]>([]),
    [tooManyDuplicates, setTooManyDuplicates] = useState(false),
    [reviewedIds, setReviewedIds] = useState<string[]>([]);
  const {
    selected: verifiedCandidate,
    setSelected: setVerifiedCandidate,
    busy: verificationPending,
    error: verificationError,
    open: openVerification,
  } = usePatientVerification(api);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body: Record<string, unknown> = {
      familyName: String(f.get("familyName")).trim(),
      givenName: String(f.get("givenName")).trim(),
      contactPreference: contact,
      preferredLanguage: f.get("preferredLanguage"),
      isSynthetic: true,
      ...(confirmed ? { confirmNotDuplicate: true } : {}),
    };
    for (const k of ["nameAr", "phone", "dateOfBirth"])
      if (String(f.get(k) ?? "").trim()) body[k] = String(f.get(k)).trim();
    setPending(true);
    setError(undefined);
    try {
      const r = await api.register(intent.payload(body), intent.key);
      saved(r.patient);
    } catch (err) {
      intent.failed(err);
      setError(err);
      const possible = err instanceof ApiError && Array.isArray(err.details.possibleDuplicates)
        ? err.details.possibleDuplicates
        : null;
      setDuplicate(possible !== null);
      setTooManyDuplicates(err instanceof ApiError && err.details.tooManyPossibleDuplicates === true);
      setCandidates(possible?.filter((candidate): candidate is DuplicateCandidate =>
        typeof candidate === "object" && candidate !== null &&
        "id" in candidate && typeof candidate.id === "string" &&
        "fileNo" in candidate && typeof candidate.fileNo === "number",
      ) ?? []);
      setReviewedIds([]);
      setVerifiedCandidate(undefined);
      setConfirmed(false);
    } finally {
      setPending(false);
    }
  }
  const exit = () => {
    if (intent.uncertain) uncertainClose();
    close();
  };
  return (
    <Modal title={w.formPatient} w={w} busy={pending} close={exit}>
      <form onSubmit={(e) => void submit(e)}>
        <p className="muted">{w.required}</p>
        {error !== undefined && <ErrorBox error={error} w={w} />}
        {intent.uncertain && (
          <p className="uncertain" role="alert">
            {w.uncertain}
          </p>
        )}
        {duplicate && (
          <div className="warning">
            <p role="alert">{w.duplicate}</p>
            <p>{w.identityCheck}</p>
            {tooManyDuplicates && <p role="alert">{w.duplicateOverflow}</p>}
            <ul>
              {candidates.map((candidate) => (
                <li key={candidate.id}>
                  <button
                    type="button"
                    className="secondary"
                    disabled={pending || verificationPending || intent.uncertain}
                    onClick={() => void openVerification(candidate)}
                  >
                    {w.reviewExistingFile} · {w.file} <bdi>#{candidate.fileNo}</bdi>
                  </button>
                  {reviewedIds.includes(candidate.id) && <span> ✓ {w.reviewedFile}</span>}
                </li>
              ))}
            </ul>
            {verificationPending && <Loading label={w.loading} />}
            {verificationError !== undefined && <ErrorBox error={verificationError} w={w} />}
            {verifiedCandidate && candidates.some((candidate) => candidate.id === verifiedCandidate.id) && (
              <div className="patient-context">
                <strong><bdi>{nameOf(verifiedCandidate)}</bdi> · {w.file} <bdi>#{verifiedCandidate.fileNo}</bdi></strong>
                {verifiedCandidate.dateOfBirth && <p>{w.dob}: <bdi>{verifiedCandidate.dateOfBirth.split("-").reverse().join("/")}</bdi></p>}
                {verifiedCandidate.phoneLast4 && <p>{w.phoneEnding} <bdi>••••{verifiedCandidate.phoneLast4}</bdi></p>}
                <div className="form-footer">
                  <button type="button" className="secondary" onClick={() => existing(verifiedCandidate)}>{w.useExistingFile}</button>
                  <button type="button" className="secondary" disabled={reviewedIds.includes(verifiedCandidate.id)}
                    onClick={() => setReviewedIds((ids) => ids.includes(verifiedCandidate.id) ? ids : [...ids, verifiedCandidate.id])}>
                    {w.markReviewedFile}
                  </button>
                </div>
              </div>
            )}
            <label className="check-label">
              <input
                type="checkbox"
                checked={confirmed}
                disabled={verificationPending || tooManyDuplicates || candidates.length === 0 || reviewedIds.length !== candidates.length}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              {w.confirmDuplicate}
            </label>
          </div>
        )}
        <fieldset disabled={pending || intent.uncertain} className="form-grid"
          onChangeCapture={() => {
            if (duplicate) {
              setDuplicate(false);
              setConfirmed(false);
              setCandidates([]);
              setTooManyDuplicates(false);
              setReviewedIds([]);
              setVerifiedCandidate(undefined);
              setError(undefined);
            }
          }}>
          <label>
            {w.familyName} *
            <input
              name="familyName"
              required
              maxLength={80}
              autoComplete="off"
            />
          </label>
          <label>
            {w.givenName} *
            <input
              name="givenName"
              required
              maxLength={80}
              autoComplete="off"
            />
          </label>
          <label className="span-2">
            {w.nameAr}
            <input
              name="nameAr"
              dir="rtl"
              lang="ar"
              maxLength={160}
              autoComplete="off"
            />
          </label>
          <label>
            {w.dob}
            <input type="date" name="dateOfBirth" min="1900-01-02" />
          </label>
          <label>
            {w.phoneOptional}
            <input
              name="phone"
              type="tel"
              dir="ltr"
              required={contact === "BASIC_PHONE_CALL"}
              maxLength={20}
              pattern="\+?[0-9 ]{6,20}"
              autoComplete="off"
            />
          </label>
          <label>
            {w.contact}
            <select
              value={contact}
              onChange={(e) => setContact(e.target.value)}
            >
              <option value="IN_PERSON">{w.inPerson}</option>
              <option value="BASIC_PHONE_CALL">{w.call}</option>
              <option value="NONE">{w.none}</option>
            </select>
          </label>
          <label>
            {w.patientLanguage}
            <select name="preferredLanguage" defaultValue="fr">
              <option value="fr">{w.french}</option>
              <option value="ar">{w.arabic}</option>
            </select>
          </label>
        </fieldset>
        <footer className="form-footer">
          <button
            type="button"
            className="secondary"
            disabled={pending}
            onClick={exit}
          >
            {w.cancel}
          </button>
          <button
            className="primary"
            disabled={pending || verificationPending || (duplicate && (tooManyDuplicates || !confirmed || candidates.length === 0 || reviewedIds.length !== candidates.length))}
          >
            {pending ? w.saving : intent.uncertain ? w.retry : w.savePatient}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

export function Scheduling({
  api,
  w,
  board,
  patient: initial,
  close,
  saved,
  uncertainClose,
}: {
  api: Api;
  w: Words;
  board: Board;
  patient?: Patient;
  close: () => void;
  saved: (day: string) => void;
  uncertainClose: () => void;
}) {
  const [patient, setPatient] = useState(initial),
    [intent] = useState(() => new WriteIntent()),
    [pending, setPending] = useState(false),
    [error, setError] = useState<unknown>(),
    [badTime, setBadTime] = useState(false),
    [overlap, setOverlap] = useState(false),
    [allowOverlap, setAllowOverlap] = useState(false);
  const dentists = [
    ...new Map(
      board.visits.flatMap((v) =>
        v.dentist ? [[v.dentist.id, v.dentist] as const] : [],
      ),
    ).values(),
  ];
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!patient) {
      setError(new ApiError("VALIDATION_FAILED"));
      return;
    }
    const f = new FormData(e.currentTarget);
    let body: Record<string, unknown>;
    try {
      body = intent.uncertain
        ? intent.payload({})
        : {
            patientId: patient.id,
            scheduledAt: clinicInstant(
              String(f.get("day")),
              String(f.get("time")),
              board.timezone,
            ),
            durationMin: Number(f.get("duration")),
            ...(f.get("dentist") ? { dentistId: f.get("dentist") } : {}),
            ...(allowOverlap ? { allowOverlap: true } : {}),
          };
    } catch {
      setBadTime(true);
      return;
    }
    setPending(true);
    setError(undefined);
    setBadTime(false);
    try {
      await api.schedule(intent.payload(body), intent.key);
      saved(
        new Intl.DateTimeFormat("en-CA", {
          timeZone: board.timezone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date(String(body.scheduledAt))),
      );
    } catch (err) {
      intent.failed(err);
      setError(err);
      setOverlap(
        err instanceof ApiError && Array.isArray(err.details.overlapping),
      );
    } finally {
      setPending(false);
    }
  }
  const exit = () => {
    if (intent.uncertain) uncertainClose();
    close();
  };
  return (
    <Modal title={w.formVisit} w={w} busy={pending} close={exit}>
      <form onSubmit={(e) => void submit(e)}>
        {error !== undefined && <ErrorBox error={error} w={w} />}
        {badTime && (
          <div className="error-box" role="alert">
            {w.badTime}
          </div>
        )}
        {intent.uncertain && (
          <p className="uncertain" role="alert">
            {w.uncertain}
          </p>
        )}
        {overlap && (
          <div className="warning">
            <p>{w.overlapConflict}</p>
            <label className="check-label">
              <input
                type="checkbox"
                checked={allowOverlap}
                onChange={(e) => setAllowOverlap(e.target.checked)}
              />
              {w.confirmOverlap}
            </label>
          </div>
        )}
        <fieldset disabled={pending || intent.uncertain}>
          {patient ? (
            <div className="patient-context">
              <span className="avatar">{patient.givenName.slice(0, 1)}</span>
              <div>
                <small>{w.selectedPatient}</small>
                <strong>
                  <bdi>{nameOf(patient)}</bdi> · <bdi>#{patient.fileNo}</bdi>
                </strong>
              </div>
            </div>
          ) : (
            <PatientPicker api={api} w={w} select={setPatient} />
          )}
          <p className="muted">{w.patientSafety}</p>
          <div className="form-grid">
            <label>
              {w.day} *
              <input name="day" type="date" required defaultValue={board.day} />
            </label>
            <label>
              {w.time} *
              <input name="time" type="time" required defaultValue="09:00" />
              <small>
                <bdi>{board.timezone}</bdi>
              </small>
            </label>
            <label>
              {w.duration} *
              <input
                name="duration"
                type="number"
                min={5}
                max={480}
                step={1}
                required
                defaultValue={30}
              />
            </label>
            <label>
              {w.dentist}
              <select name="dentist" aria-label={w.dentist}>
                <option value="">{w.unassigned}</option>
                {dentists.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name ?? w.unnamed}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="muted">{w.dentistHint}</p>
        </fieldset>
        <footer className="form-footer">
          <button
            type="button"
            className="secondary"
            disabled={pending}
            onClick={exit}
          >
            {w.cancel}
          </button>
          <button
            className="primary"
            disabled={pending || !patient || (overlap && !allowOverlap)}
          >
            {pending ? w.saving : intent.uncertain ? w.retry : w.save}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
