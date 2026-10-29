import { Checkout } from "./checkout.tsx";
import { useState, useCallback } from "react";
import { Api, WriteIntent } from "./api.ts";
import type { Board, Visit, Patient } from "./api.ts";
import type { Words } from "./i18n.ts";
import { nameOf } from "./forms.tsx";
import { Empty, ErrorBox, Icon, Loading, useResource } from "./ui.tsx";
export function DayBoard({
  board,
  w,
  writable,
  api,
  refreshed,
  notify,
  canConfirmCare,
  confirmCare,
}: {
  board: Board;
  w: Words;
  writable: boolean;
  api: Api;
  refreshed: () => void;
  notify: (message: string) => void;
  canConfirmCare: boolean;
  confirmCare: (visit: Visit) => void;
}) {
  const [filter, setFilter] = useState("all");
  const visits = board.visits.filter(
    (v) => filter === "all" || v.status === filter,
  );
  return (
    <>
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
        <span>
          <bdi>{visits.length}</bdi> {w.total.toLowerCase()}
        </span>
      </div>
      {visits.length === 0 ? (
        <Empty title={w.emptyBoard} text={w.emptyBoardHint} />
      ) : (
        <div className="visit-list">
          {visits.map((v) => (
            <VisitRow
              key={v.id}
              visit={v}
              w={w}
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
  writable,
  api,
  refreshed,
  notify,
  canConfirmCare,
  confirmCare,
}: {
  visit: Visit;
  w: Words;
  writable: boolean;
  api: Api;
  refreshed: () => void;
  notify: (m: string) => void;
  canConfirmCare: boolean;
  confirmCare: (visit: Visit) => void;
}) {
  const [checkout, setCheckout] = useState(false);
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
        {error !== undefined && <ErrorBox error={error} w={w} />}
        {intent.uncertain && (
          <p role="alert" className="uncertain">
            {w.uncertain}
          </p>
        )}
      </div>
      {checkout && (
        <Checkout
          api={api}
          visit={v}
          w={w}
          close={() => {
            setCheckout(false);
            refreshed();
          }}
        />
      )}
      <div className="visit-actions">
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
  const resource = useResource(
    useCallback(
      (signal: AbortSignal) => api.patients(search, signal),
      [api, search],
    ),
  );
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
              </div>
              <span className="contact-label">
                {contact[p.contactPreference] ?? p.contactPreference}
              </span>
              {writable && (
                <button
                  className="secondary"
                  disabled={!scheduleReady}
                  onClick={() => schedule(p)}
                >
                  {w.scheduleFor}
                  <Icon name="arrow" size={16} />
                </button>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
