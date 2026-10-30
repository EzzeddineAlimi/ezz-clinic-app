import { Checkout } from "./checkout.tsx";
import { VisitStatusModal } from "./visit-status.tsx";
import { ClinicalWorkspace } from "./clinical-workspace.tsx";
import { clinicalText } from "./clinical-text.ts";
import { useState, useCallback } from "react";
import { Api, WriteIntent } from "./api.ts";
import type { Board, Visit, Patient } from "./api.ts";
import type { Words, Lang } from "./i18n.ts";
import { nameOf, usePatientVerification } from "./forms.tsx";
import { Empty, ErrorBox, Icon, Loading, Modal, useResource } from "./ui.tsx";
function patientNameKey(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f\u0640\u064b-\u065f\u0670]/g, "")
    .toLocaleLowerCase().replace(/[أإآٱ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي");
}
export function DayBoard({
  board,
  w,
  lang,
  writable,
  api,
  refreshed,
  notify,
  canConfirmCare,
  confirmCare,
}: {
  board: Board;
  w: Words;
  lang: Lang;
  writable: boolean;
  api: Api;
  refreshed: () => void;
  notify: (message: string) => void;
  canConfirmCare: boolean;
  confirmCare: (visit: Visit) => void;
}) {
  const [filter, setFilter] = useState("all");
  const [patientQuery, setPatientQuery] = useState("");
  const [dentistId, setDentistId] = useState("all");
  const dentists = [...new Map(board.visits.flatMap(v =>
    v.dentist ? [[v.dentist.id, v.dentist] as const] : [],
  )).values()].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  const query = patientNameKey(patientQuery.trim());
  const hasFilters = filter !== "all" || patientQuery.trim().length > 0 || dentistId !== "all";
  const clearFilters = () => { setFilter("all"); setPatientQuery(""); setDentistId("all"); };
  const visits = board.visits.filter(v =>
    (filter === "all" || v.status === filter) &&
    (dentistId === "all" || v.dentist?.id === dentistId) &&
    (!query ||
      patientNameKey(nameOf(v.patient)).includes(query) ||
      (!!v.patient.nameAr && patientNameKey(v.patient.nameAr).includes(query)) ||
      String(v.patient.fileNo) === patientQuery.trim().replace(/^#/, "")),
  );
  return (
    <>
      <div className="dayboard-filters">
        <label>{w.boardSearch}
          <input type="search" value={patientQuery} maxLength={80}
            onChange={e => setPatientQuery(e.target.value)} />
        </label>
        <label>{w.dentist}
          <select value={dentistId} onChange={e => setDentistId(e.target.value)}>
            <option value="all">{w.allDentists}</option>
            {dentists.map(d => <option key={d.id} value={d.id}>{d.name ?? w.unnamed}</option>)}
          </select>
        </label>
      </div>
      <div className="filter-tabs" aria-label={w.status}>
        {["all", "SCHEDULED", "ARRIVED", "COMPLETED"].map((s) => (
          <button
            key={s}
            aria-pressed={filter === s}
            onClick={() => setFilter(s)}
          >
            {s === "all" ? w.all : w[s as Visit["status"]]}
          </button>
        ))}
        <span data-testid="dayboard-result-count" role="status">
          <bdi>{visits.length}</bdi>{hasFilters && <> / <bdi>{board.visits.length}</bdi></>} {w.total.toLowerCase()}
        </span>
      </div>
      {visits.length === 0 ? (
        <Empty
          title={hasFilters ? w.noMatchingVisits : w.emptyBoard}
          text={hasFilters ? w.noMatchingVisitsHint : w.emptyBoardHint}
          action={hasFilters ? <button type="button" className="secondary" onClick={clearFilters}>{w.clearBoardFilters}</button> : undefined}
        />
      ) : (
        <div className="visit-list">
          {visits.map((v) => (
            <VisitRow
              key={v.id}
              visit={v}
              w={w}
              lang={lang}
              timezone={board.timezone}
              writable={writable}
              api={api}
              refreshed={refreshed}
              notify={notify}
              canConfirmCare={canConfirmCare}
              confirmCare={confirmCare}
            />
          ))}
        </div>
      )}
    </>
  );
}
function VisitRow({
  visit: v,
  w,
  lang,
  timezone,
  writable,
  api,
  refreshed,
  notify,
  canConfirmCare,
  confirmCare,
}: {
  visit: Visit;
  w: Words;
  lang: Lang;
  timezone: string;
  writable: boolean;
  api: Api;
  refreshed: () => void;
  notify: (m: string) => void;
  canConfirmCare: boolean;
  confirmCare: (visit: Visit) => void;
}) {
  const [checkout, setCheckout] = useState(false);
  const [statusAction, setStatusAction] = useState<"NO_SHOW" | "CANCELLED">();
  const [clinical, setClinical] = useState(false);
  const [error, setError] = useState<unknown>(),
    [pending, setPending] = useState(false),
    [intent] = useState(() => new WriteIntent());
  async function arrive() {
    setPending(true);
    setError(undefined);
    try {
      await api.arrive(v.id, intent.key);
      notify(w.savedArrival);
      refreshed();
    } catch (err) {
      intent.failed(err);
      setError(err);
    } finally {
      setPending(false);
    }
  }
  return (
    <article className={`visit-row status-${v.status}`}>
      <div className="visit-time">
        <strong>
          <bdi>{v.localTime}</bdi>
        </strong>
        <small>
          {v.durationMin} {w.minutes}
        </small>
      </div>
      <span className="visit-line" />
      <div className="visit-person">
        <div className="name-line">
          <span className="avatar">{v.patient.givenName.slice(0, 1)}</span>
          <div>
            <h3>
              <bdi>{nameOf(v.patient)}</bdi>
            </h3>
            <span>
              {w.file} <bdi>#{v.patient.fileNo}</bdi>
              {v.patient.nameAr && (
                <>
                  {" "}
                  · <bdi lang="ar">{v.patient.nameAr}</bdi>
                </>
              )}
            </span>
          </div>
        </div>
        <div className="visit-meta">
          <span>{v.dentist?.name ?? w.unassigned}</span>
          {v.flags.includes("IN_PERSON_CONTACT_ONLY") && (
            <span>{w.inPerson}</span>
          )}
          {v.flags.includes("SAME_NAME_OTHER_FILE") && (
            <span className="flag">{w.sameName}</span>
          )}
          {v.flags.includes("OVERLAPS_SAME_DENTIST") && (
            <span className="flag">{w.overlap}</span>
          )}
          {v.flags.includes("NOT_ARRIVED_PAST_START") && (
            <span className="flag">{w.late}</span>
          )}
        </div>
        {(v.status === "NO_SHOW" || v.status === "CANCELLED") && v.statusReason && (
          <p className="muted">{w.visitReason}: <bdi>{v.statusReason}</bdi></p>
        )}
        {error !== undefined && <ErrorBox error={error} w={w} />}
        {intent.uncertain && (
          <p role="alert" className="uncertain">
            {w.uncertain}
          </p>
        )}
      </div>
      {clinical && (
        <ClinicalWorkspace api={api} visit={v} lang={lang} w={w}
          close={() => setClinical(false)} />
      )}
      {statusAction && (
        <VisitStatusModal
          api={api}
          visit={v}
          status={statusAction}
          w={w}
          close={() => setStatusAction(undefined)}
          saved={() => {
            notify(statusAction === "NO_SHOW" ? w.savedNoShow : w.savedCancellation);
            setStatusAction(undefined);
            refreshed();
          }}
          uncertainClose={() => {
            notify(w.ambiguousClosed);
            refreshed();
          }}
        />
      )}
      {checkout && (
        <Checkout
          api={api}
          visit={v}
          timezone={timezone}
          w={w}
          close={() => {
            setCheckout(false);
            refreshed();
          }}
        />
      )}
      <div className="visit-actions">
        {canConfirmCare && !["CANCELLED", "NO_SHOW"].includes(v.status) && (
          <button className="secondary compact" onClick={() => setClinical(true)}>
            {clinicalText[lang].title}
          </button>
        )}
        {canConfirmCare && ["ARRIVED", "IN_CHAIR", "COMPLETED"].includes(v.status) && (
          <button className="secondary compact" onClick={() => confirmCare(v)}>
            {w.confirmCare}
          </button>
        )}
        {writable && v.status === "COMPLETED" && (
          <button className="primary compact" onClick={() => setCheckout(true)}>
            {w.checkout}
          </button>
        )}
        <span className={`status-badge badge-${v.status}`}>
          <i />
          {w[v.status]}
        </span>
        {writable && v.status === "SCHEDULED" && (
          <button
            className="secondary compact"
            disabled={pending}
            onClick={() => void arrive()}
          >
            {pending ? w.saving : intent.uncertain ? w.retry : w.arrival}
          </button>
        )}
        {writable && v.status === "SCHEDULED" &&
          new Date(v.scheduledAt).getTime() <= Date.now() && (
            <button className="secondary compact" disabled={pending} onClick={() => setStatusAction("NO_SHOW")}>
              {w.markNoShow}
            </button>
          )}
        {writable && ["SCHEDULED", "ARRIVED"].includes(v.status) && (
          <button className="secondary compact" disabled={pending} onClick={() => setStatusAction("CANCELLED")}>
            {w.cancelVisit}
          </button>
        )}
      </div>
    </article>
  );
}
export function PatientDirectory({
  api,
  w,
  writable,
  scheduleReady,
  schedule,
  register,
}: {
  api: Api;
  w: Words;
  writable: boolean;
  scheduleReady: boolean;
  schedule: (p: Patient) => void;
  register: () => void;
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
  const sameVisibleName = (p: Patient) =>
    !!p.hasSameNameInClinic || (resource.data?.patients ?? []).filter(other =>
      patientNameKey(nameOf(other)) === patientNameKey(nameOf(p)) ||
      (!!p.nameAr && !!other.nameAr && patientNameKey(other.nameAr) === patientNameKey(p.nameAr)),
    ).length > 1;
  const contact: Record<string, string> = {
    IN_PERSON: w.inPerson,
    NONE: w.none,
    BASIC_PHONE_CALL: w.call,
    SMS: "SMS",
  };
  return (
    <section className="board-panel">
      <form
        className="directory-search"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(query.trim());
          resource.refresh();
        }}
      >
        <label className="search-input">
          <Icon name="search" />
          <span className="sr-only">{w.searchLabel}</span>
          <input
            type="search"
            maxLength={80}
            placeholder={w.searchLabel}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <button className="primary">{w.search}</button>
      </form>
      <p className="search-help">{w.searchHint}</p>
      {resource.loading ? (
        <Loading label={w.loading} />
      ) : resource.error ? (
        <ErrorBox error={resource.error} w={w}>
          <button className="secondary" onClick={resource.refresh}>
            {w.refresh}
          </button>
        </ErrorBox>
      ) : !resource.data?.patients.length ? (
        <Empty
          title={w.noPatients}
          text={w.noPatientsHint}
          action={
            writable && (
              <button className="primary" onClick={register}>
                {w.newPatient}
              </button>
            )
          }
        />
      ) : (
        <div className="patient-list">
          {resource.data.patients.map((p) => (
            <article className="patient-row" key={p.id}>
              <span className="avatar">{p.givenName.slice(0, 1)}</span>
              <div>
                <h3>
                  <bdi>{nameOf(p)}</bdi>
                </h3>
                <span>
                  {w.file} <bdi>#{p.fileNo}</bdi>
                  {p.nameAr && (
                    <>
                      {" "}
                      · <bdi lang="ar">{p.nameAr}</bdi>
                    </>
                  )}
                </span>
                {(p.birthYear || p.phoneLast4) && (
                  <small className="patient-identity-hints">
                    {p.birthYear && <span>{w.birthYear}: <bdi>{p.birthYear}</bdi></span>}
                    {p.phoneLast4 && <span> · {w.phoneEnding} <bdi>••••{p.phoneLast4}</bdi></span>}
                  </small>
                )}
              </div>
              <span className="contact-label">
                {contact[p.contactPreference] ?? p.contactPreference}
              </span>
              {writable && (
                <button
                  className="secondary"
                  disabled={!scheduleReady || verificationPending}
                  onClick={() => sameVisibleName(p) ? void openVerification(p) : schedule(p)}
                >
                  {w.scheduleFor}
                  <Icon name="arrow" size={16} />
                </button>
              )}
            </article>
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
              schedule(confirmed);
            }}>{w.confirmFile} · #{verifyPatient.fileNo}</button>
          </div>
        </Modal>
      )}
    </section>
  );
}
