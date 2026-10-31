import { useCallback, useState } from "react";
import type { FormEvent } from "react";
import { Api, ApiError, WriteIntent } from "./api.ts";
import type { Enquiry, EnquiryStatus } from "./enquiry-contracts.ts";
import type { Lang } from "./i18n.ts";
import { ErrorBox, Loading, useResource } from "./ui.tsx";
import { copy } from "./i18n.ts";

export const enquiryText = {
  fr: {
    title: "Demandes", subtitle: "Demandes reçues avant toute création de dossier patient.",
    warning: "Données fictives uniquement. Saisissez un motif administratif bref, jamais de diagnostic ni d’antécédents.",
    new: "Nouvelle demande", name: "Nom indiqué", reason: "Motif administratif",
    callback: "Coordonnée de rappel (facultative)", create: "Ajouter à la liste",
    open: "À suivre", closed: "Terminées", empty: "Aucune demande dans cette liste.",
    refresh: "Actualiser", more: "Afficher les suivantes", close: "Clore",
    reopen: "Réouvrir", saved: "Demande enregistrée, sans créer de dossier patient.",
    updated: "État mis à jour.", duplicate: "Une demande identique existe. Vérifiez la liste avant un nouvel enregistrement.",
    stale: "Cette demande a changé. Actualisez avant de décider.",
    uncertain: "Résultat non confirmé : ne créez pas une deuxième demande. Réessayez exactement la même opération.",
    retry: "Réessayer la même demande", closeMeaning: "Clore signifie retirer de la liste active, pas confirmer un contact ou un rendez-vous.",
  },
  ar: {
    title: "الطلبات", subtitle: "طلبات قبل إنشاء أي ملف مريض.",
    warning: "بيانات خيالية فقط. سجّل سببًا إداريًا موجزًا، دون تشخيص أو تاريخ طبي.",
    new: "طلب جديد", name: "الاسم المذكور", reason: "السبب الإداري",
    callback: "وسيلة معاودة الاتصال (اختياري)", create: "إضافة إلى القائمة",
    open: "قيد المتابعة", closed: "مغلقة", empty: "لا توجد طلبات في هذه القائمة.",
    refresh: "تحديث", more: "عرض المزيد", close: "إغلاق",
    reopen: "إعادة فتح", saved: "تم تسجيل الطلب دون إنشاء ملف مريض.",
    updated: "تم تحديث الحالة.", duplicate: "يوجد طلب مطابق. راجع القائمة قبل تسجيل طلب جديد.",
    stale: "تغير هذا الطلب. حدّث القائمة قبل المتابعة.",
    uncertain: "النتيجة غير مؤكدة: لا تنشئ طلبًا ثانيًا. أعد محاولة نفس العملية دون تغييرها.",
    retry: "إعادة نفس الطلب", closeMeaning: "الإغلاق يزيل الطلب من قائمة المتابعة ولا يؤكد الاتصال أو حجز موعد.",
  },
} as const;

type CreateBody = { name: string; reason: string; callback: string | null; isSynthetic: true };
type UpdateBody = CreateBody & { status: EnquiryStatus; expectedVersion: number };
type PendingUpdate = { id: string; body: UpdateBody; key: string };

export function Enquiries({ api, lang }: { api: Api; lang: Lang }) {
  const t = enquiryText[lang], w = copy[lang];
  const [status, setStatus] = useState<EnquiryStatus>("OPEN");
  const [before, setBefore] = useState<string>();
  const [entries, setEntries] = useState<Enquiry[]>([]);
  const [name, setName] = useState(""), [reason, setReason] = useState(""),
    [callback, setCallback] = useState("");
  const [createIntent, setCreateIntent] = useState(() => new WriteIntent());
  const [pendingUpdate, setPendingUpdate] = useState<PendingUpdate>();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState("");
  const list = useResource(useCallback(signal => api.enquiries(status, before, signal), [api, status, before]));
  const current = before ? entries : list.data?.enquiries ?? [];
  const rows = before ? [...entries, ...(list.data?.enquiries ?? []).filter(x => !entries.some(y => y.id === x.id))] : current;
  const nextBefore = list.data?.nextBefore ?? null;
  function reload() {
    setBefore(undefined);
    setEntries([]);
    list.refresh();
  }
  function chooseStatus(value: EnquiryStatus) {
    setStatus(value);
    setBefore(undefined);
    setEntries([]);
    setError(undefined);
    setNotice("");
  }
  function loadMore() {
    if (!nextBefore) return;
    setEntries(rows);
    setBefore(nextBefore);
  }
  async function create(e?: FormEvent<HTMLFormElement>) {
    e?.preventDefault();
    setWorking(true); setError(undefined); setNotice("");
    try {
      const body: CreateBody = { name: name.trim(), reason: reason.trim(),
        callback: callback.trim() || null, isSynthetic: true };
      await api.createEnquiry(createIntent.payload(body) as CreateBody, createIntent.key);
      setCreateIntent(new WriteIntent());
      setName(""); setReason(""); setCallback("");
      chooseStatus("OPEN");
      setNotice(t.saved);
      reload();
    } catch (cause) {
      createIntent.failed(cause);
      if (!createIntent.uncertain) setCreateIntent(new WriteIntent());
      setError(cause);
    } finally { setWorking(false); }
  }
  async function update(action: PendingUpdate) {
    setWorking(true); setError(undefined); setNotice("");
    try {
      await api.updateEnquiry(action.id, action.body, action.key);
      setPendingUpdate(undefined);
      setNotice(t.updated);
      reload();
    } catch (cause) {
      const ambiguous = cause instanceof ApiError && (cause.code === "NETWORK" || cause.status >= 500);
      setPendingUpdate(ambiguous ? action : undefined);
      setError(cause);
      if (!ambiguous) reload();
    } finally { setWorking(false); }
  }
  function changeStatus(entry: Enquiry) {
    if (pendingUpdate) return;
    const action: PendingUpdate = {
      id: entry.id, key: crypto.randomUUID(),
      body: { name: entry.name, reason: entry.reason, callback: entry.callback,
        status: entry.status === "OPEN" ? "CLOSED" : "OPEN",
        expectedVersion: entry.version, isSynthetic: true },
    };
    void update(action);
  }
  const duplicate = error instanceof ApiError && error.details.reason === "ENQUIRY_DUPLICATE";
  const stale = error instanceof ApiError && error.details.reason === "ENQUIRY_VERSION_STALE";
  return (
    <section className="board-panel enquiry-panel" aria-label={t.title}>
      <div className="panel-heading">
        <div><h2>{t.title}</h2><p>{t.warning}</p></div>
        <button className="secondary" type="button" onClick={reload} disabled={working}>{t.refresh}</button>
      </div>
      {notice && <p className="enquiry-notice" role="status">{notice}</p>}
      {error !== undefined && <div className="enquiry-notice" role="alert">
        {duplicate ? t.duplicate : stale ? t.stale : <ErrorBox error={error} w={w} />}
      </div>}
      <form className="enquiry-form" onSubmit={e => void create(e)}>
        <h3>{t.new}</h3>
        <fieldset className="form-grid" disabled={working || createIntent.uncertain || !!pendingUpdate}>
          <label>{t.name} *<input required maxLength={160} value={name} onChange={e => setName(e.target.value)} /></label>
          <label>{t.callback}<input maxLength={40} value={callback} onChange={e => setCallback(e.target.value)} /></label>
          <label className="enquiry-reason">{t.reason} *<textarea required maxLength={240}
            value={reason} onChange={e => setReason(e.target.value)} /></label>
        </fieldset>
        {createIntent.uncertain && <p role="alert">{t.uncertain}</p>}
        <button type="submit" className="primary" disabled={working || createIntent.uncertain || !!pendingUpdate}>{t.create}</button>
        {createIntent.uncertain && <button type="button" className="secondary" disabled={working}
          onClick={() => void create()}>{t.retry}</button>}
      </form>
      <div className="filter-tabs" aria-label={t.title}>
        {(["OPEN", "CLOSED"] as const).map(value => (
          <button key={value} type="button" aria-pressed={status === value} onClick={() => chooseStatus(value)}
            disabled={working || !!pendingUpdate || createIntent.uncertain}>
            {value === "OPEN" ? t.open : t.closed}
          </button>
        ))}
      </div>
      <p className="enquiry-notice">{t.closeMeaning}</p>
      {list.loading ? <Loading label={w.loading} /> : list.error ? <ErrorBox error={list.error} w={w} /> :
        rows.length === 0 ? <p className="enquiry-notice">{t.empty}</p> :
        <div className="enquiry-list">{rows.map(entry => (
          <article key={entry.id} className="enquiry-entry">
            <h3><bdi>{entry.name}</bdi></h3>
            <p><bdi>{entry.reason}</bdi></p>
            {entry.callback && <p><strong>{t.callback}: </strong><bdi>{entry.callback}</bdi></p>}
            <button type="button" className="secondary" disabled={working || createIntent.uncertain}
              onClick={() => changeStatus(entry)}>{entry.status === "OPEN" ? t.close : t.reopen}</button>
          </article>
        ))}</div>
      }
      {pendingUpdate && <div className="enquiry-notice" role="alert"><p>{t.uncertain}</p>
        <button type="button" className="secondary" disabled={working}
          onClick={() => void update(pendingUpdate)}>{t.retry}</button></div>}
      {nextBefore && !list.loading && <button type="button" className="secondary enquiry-more"
        disabled={working} onClick={loadMore}>{t.more}</button>}
    </section>
  );
}
