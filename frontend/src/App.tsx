import { Login } from "./Login.tsx";
import { DayBoard, PatientDirectory } from "./pages.tsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { Api, canWrite } from "./api.ts";
import type { Patient, Session, Visit } from "./api.ts";
import { copy } from "./i18n.ts";
import type { Lang, Words } from "./i18n.ts";
import { dateLabel, shiftDay } from "./time.ts";
import { Registration, Scheduling, nameOf } from "./forms.tsx";
import { CareConfirmation } from "./care.tsx";
import { OwnerCashControl, cashText } from "./owner-cash.tsx";
import {
  Brand,
  ErrorBox,
  Icon,
  Language,
  Loading,
  useResource,
} from "./ui.tsx";

type Auth = { api: Api; session: Session; clinicCode: string };
export default function App() {
  const [lang, setLang] = useState<Lang>("fr"),
    [auth, setAuth] = useState<Auth | null>(null),
    [notice, setNotice] = useState<"" | "sessionExpired" | "sessionLocal">(""),
    [online, setOnline] = useState(navigator.onLine);
  const w = copy[lang];
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
  }, [lang]);
  useEffect(() => {
    const changed = () => setOnline(navigator.onLine);
    window.addEventListener("online", changed);
    window.addEventListener("offline", changed);
    return () => {
      window.removeEventListener("online", changed);
      window.removeEventListener("offline", changed);
    };
  }, []);
  const generation = useRef(0);
  const logout = async () => {
    if (!auth) return;
    const current = auth;
    generation.current++;
    setAuth(null);
    try {
      await current.api.logout();
    } catch {
      setNotice("sessionLocal");
    }
  };
  return (
    <>
      <div className="demo-banner">{w.fictional}</div>
      {!online && (
        <div className="offline-banner" role="alert">
          {w.offline}
        </div>
      )}
      {auth ? (
        <Workspace
          key={auth.session.staff.id}
          auth={auth}
          lang={lang}
          w={w}
          setLang={setLang}
          logout={() => void logout()}
        />
      ) : (
        <Login
          w={w}
          lang={lang}
          setLang={setLang}
          notice={notice ? w[notice] : ""}
          authenticated={async (token, clinicCode) => {
            const epoch = ++generation.current;
            const api = new Api(token, () => {
              if (generation.current === epoch) {
                generation.current++;
                setAuth(null);
                setNotice("sessionExpired");
              }
            });
            const session = await api.session();
            setNotice("");
            setAuth({ api, session, clinicCode });
          }}
        />
      )}
    </>
  );
}
function Workspace({
  auth,
  lang,
  w,
  setLang,
  logout,
}: {
  auth: Auth;
  lang: Lang;
  w: Words;
  setLang: (lang: Lang) => void;
  logout: () => void;
}) {
  const [tab, setTab] = useState<"agenda" | "patients" | "cash">("agenda"),
    [day, setDay] = useState(""),
    [modal, setModal] = useState<"register" | "schedule" | "care" | null>(null),
    [selected, setSelected] = useState<Patient>(),
    [selectedVisit, setSelectedVisit] = useState<Visit>(),
    [toast, setToast] = useState(""),
    [patientRevision, setPatientRevision] = useState(0);
  const board = useResource(
    useCallback(
      (signal: AbortSignal) => auth.api.board(day, signal),
      [auth.api, day],
    ),
  );
  const writable = canWrite(auth.session);
  const current = board.data;
  const [today, setToday] = useState("");
  useEffect(() => {
    if (!day && current) setToday(current.day);
  }, [day, current]);
  const plan = (p?: Patient) => {
    setSelected(p);
    setModal("schedule");
  };
  const beginCare = (visit: Visit) => {
    setSelectedVisit(visit);
    setModal("care");
  };
  const roles: Record<string, string> = {
    OWNER: w.roleOwner,
    DENTIST: w.roleDentist,
    RECEPTIONIST: w.roleReceptionist,
    ASSISTANT: w.roleAssistant,
  };
  const slipError = toast === w.slipStale || toast === w.slipUnavailable;
  return (
    <div className="app-layout">
      <a className="skip-link" href="#main">
        {w.agenda}
      </a>
      <aside className="sidebar">
        <Brand />
        <div className="workspace-label">{w.reception}</div>
        <nav aria-label={w.available}>
          <button
            aria-current={tab === "agenda" ? "page" : undefined}
            onClick={() => setTab("agenda")}
          >
            <Icon name="calendar" />
            {w.agenda}
            <span className="nav-dot" />
          </button>
          <button
            aria-current={tab === "patients" ? "page" : undefined}
            onClick={() => setTab("patients")}
          >
            <Icon name="people" />
            {w.patients}
          </button>
          {auth.session.staff.roles.includes("OWNER") && (
            <button aria-current={tab === "cash" ? "page" : undefined}
              onClick={() => setTab("cash")}>
              <Icon name="check" />
              {cashText[lang].tab}
            </button>
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className="profile">
            <span className="avatar">
              {auth.session.staff.displayName.slice(0, 1)}
            </span>
            <div>
              <strong>
                <bdi>{auth.session.staff.displayName}</bdi>
              </strong>
              <small>
                {auth.session.staff.roles.map((r) => roles[r]).join(" · ")}
              </small>
            </div>
          </div>
          <button className="logout" onClick={logout}>
            <Icon name="logout" />
            {w.logout}
          </button>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div>
            <span className="breadcrumb">
              EZZ Clinic <span>/</span> {tab === "cash" ? cashText[lang].tab : w[tab]}
            </span>
            <small>
              <bdi>{auth.clinicCode}</bdi>
            </small>
          </div>
          <Language lang={lang} setLang={setLang} w={w} />
        </header>
        <main id="main" tabIndex={-1} className="main-content">
          <div className="page-heading">
            <div>
              <p className="eyebrow">{w.reception}</p>
              <h1>{tab === "agenda" ? w.welcome : tab === "cash" ? cashText[lang].title : w.patientTitle}</h1>
              <p className="muted">
                {tab === "agenda" ? w.subtitle : tab === "cash" ? cashText[lang].subtitle : w.patientSub}
              </p>
            </div>
            {writable && tab !== "cash" && (
              <button
                className="primary"
                disabled={tab === "agenda" && !current}
                onClick={() => {
                  if (tab === "agenda") plan();
                  else setModal("register");
                }}
              >
                <Icon name="plus" />
                {tab === "agenda" ? w.newVisit : w.newPatient}
              </button>
            )}
          </div>
          {toast && (
            <div className={`toast${slipError ? " toast-error" : ""}`} role={slipError ? "alert" : "status"}>
              <Icon name={slipError ? "close" : "check"} />
              <span>{toast}</span>
              <button
                className="icon-button"
                aria-label={w.cancel}
                onClick={() => setToast("")}
              >
                <Icon name="close" />
              </button>
            </div>
          )}
          {tab === "patients" && board.error !== undefined && (
            <ErrorBox error={board.error} w={w}>
              <button className="secondary" onClick={board.refresh}>
                {w.refresh}
              </button>
            </ErrorBox>
          )}
          {!writable && <p className="read-only">{w.readOnly}</p>}
          {tab === "agenda" ? (
            <>
              <section className="stats" aria-label={w.agenda}>
                {[
                  [w.total, current?.summary.total],
                  [
                    w.expected,
                    current?.summary.byStatus.SCHEDULED ??
                      (current ? 0 : undefined),
                  ],
                  [
                    w.waiting,
                    current?.summary.byStatus.ARRIVED ??
                      (current ? 0 : undefined),
                  ],
                  [
                    w.done,
                    current?.summary.byStatus.COMPLETED ??
                      (current ? 0 : undefined),
                  ],
                ].map(([label, count], i) => (
                  <div className="stat" key={label}>
                    <span className={`stat-icon stat-${i}`}>
                      <Icon
                        name={
                          i === 2 ? "people" : i === 3 ? "check" : "calendar"
                        }
                      />
                    </span>
                    <span>
                      <small>{label}</small>
                      <strong>{count ?? "—"}</strong>
                    </span>
                  </div>
                ))}
              </section>
              <section className="board-panel">
                <div className="panel-heading">
                  <div>
                    <h2>{w.boardTitle}</h2>
                    <p>{w.boardSub}</p>
                  </div>
                  <button
                    className="icon-button"
                    onClick={board.refresh}
                    aria-label={w.refresh}
                  >
                    ↻
                  </button>
                </div>
                <div className="date-toolbar">
                  <div className="date-title">
                    {current ? dateLabel(current.day, lang) : w.agenda}
                    {current && (
                      <small>
                        {w.clinicTime} · <bdi>{current.timezone}</bdi>
                      </small>
                    )}
                  </div>
                  <div className="date-controls">
                    <button
                      className="secondary"
                      disabled={!today}
                      onClick={() => setDay("")}
                    >
                      {w.today}
                    </button>
                    <button
                      className="icon-button prev"
                      aria-label={w.previous}
                      disabled={!current}
                      onClick={() =>
                        current && setDay(shiftDay(current.day, -1))
                      }
                    >
                      <Icon name="arrow" />
                    </button>
                    <label className="sr-only" htmlFor="board-date">
                      {w.day}
                    </label>
                    <input
                      id="board-date"
                      type="date"
                      value={day || current?.day || ""}
                      onChange={(e) => setDay(e.target.value)}
                    />
                    <button
                      className="icon-button"
                      aria-label={w.next}
                      disabled={!current}
                      onClick={() =>
                        current && setDay(shiftDay(current.day, 1))
                      }
                    >
                      <Icon name="arrow" />
                    </button>
                  </div>
                </div>
                {board.loading ? (
                  <Loading label={w.loading} />
                ) : board.error ? (
                  <ErrorBox error={board.error} w={w}>
                    <button className="secondary" onClick={board.refresh}>
                      {w.refresh}
                    </button>
                  </ErrorBox>
                ) : (
                  current && (
                    <DayBoard
                      key={current.day}
                      board={current}
                      w={w}
                      lang={lang}
                      writable={writable}
                      api={auth.api}
                      refreshed={board.refresh}
                      notify={setToast}
                      canConfirmCare={auth.session.staff.roles.includes("DENTIST")}
                      confirmCare={beginCare}
                    />
                  )
                )}
              </section>
            </>
          ) : tab === "cash" && auth.session.staff.roles.includes("OWNER") ? (
            <OwnerCashControl api={auth.api} lang={lang} w={w} />
          ) : (
            <PatientDirectory
              key={patientRevision}
              api={auth.api}
              w={w}
              writable={writable}
              scheduleReady={!!current}
              schedule={plan}
              register={() => setModal("register")}
            />
          )}
        </main>
        <footer className="workspace-footer">
          EZZ Clinic <span>•</span> {w.fictional}
        </footer>
      </div>
      {modal === "care" && selectedVisit && (
        <CareConfirmation
          api={auth.api}
          visit={selectedVisit}
          w={w}
          close={() => setModal(null)}
          uncertainClose={() => setToast(w.ambiguousClosed)}
          saved={() => {
            setModal(null);
            setToast(w.careSaved);
            board.refresh();
          }}
        />
      )}
      {modal === "register" && (
        <Registration
          api={auth.api}
          w={w}
          close={() => setModal(null)}
          uncertainClose={() => setToast(w.ambiguousClosed)}
          saved={(p) => {
            setModal(null);
            setToast(`${w.savedPatient} ${nameOf(p)} · #${p.fileNo}`);
            setPatientRevision((r) => r + 1);
          }}
        />
      )}
      {modal === "schedule" && current && (
        <Scheduling
          api={auth.api}
          w={w}
          board={current}
          patient={selected}
          close={() => setModal(null)}
          uncertainClose={() => setToast(w.ambiguousClosed)}
          saved={(savedDay) => {
            setModal(null);
            setToast(w.savedVisit);
            setDay(savedDay);
            board.refresh();
          }}
        />
      )}
    </div>
  );
}
