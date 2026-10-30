import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Api, ApiError } from "./api.ts";
import { amount } from "./billing.ts";
import { parseDrawerMillimes } from "./cash-contracts.ts";
import { cashIndependenceNotes } from "./cash-evidence.ts";
import type { Lang, Words } from "./i18n.ts";
import { clinicPaymentTime } from "./time.ts";
import { ErrorBox, Loading, useResource } from "./ui.tsx";

export const cashText = {
  fr: {
    tab: "Caisse",
    title: "Contrôle de caisse",
    subtitle: "Comptage physique facultatif, revue indépendante des écritures.",
    blank: "Aucune période de caisse ouverte.",
    open: "Ouvrir la première période",
    opening: "Fonds de caisse initial (TND)",
    password: "Mot de passe du responsable (confirmation d'identité)",
    number: "Période",
    attempts: "Comptages enregistrés",
    blind: "Comptage à l'aveugle : aucun total théorique n'est révélé avant un premier comptage.",
    independent: "Entrez uniquement les espèces comptées physiquement, par vous ou un tiers présent. Une saisie informatique n'est pas une preuve d'indépendance physique.",
    counted: "Espèces effectivement comptées (TND)",
    reason: "Motif du recomptage (obligatoire)",
    entry: "Saisir le comptage",
    submit: "Enregistrer le comptage",
    review: "Consulter le contrôle",
    countAgain: "Effectuer un nouveau comptage",
    compare: "Comparaison des écritures et du comptage",
    expected: "Espèces attendues selon les écritures",
    actual: "Comptées physiquement (déclarées)",
    difference: "Écart (compté moins attendu)",
    first: "Premier écart",
    evidence: "Qualification de la preuve",
    evidenceSoftware: "Rôle du compteur contrôlé par le logiciel, pas indépendance physique vérifiée.",
    evidenceStaff: "Comptage non indépendant selon les règles du logiciel.",
    note: "Un écart ne prouve pas un vol. Les espèces jamais enregistrées ne peuvent pas être détectées à partir du seul journal.",
    after: "Opérations espèces enregistrées après le dernier comptage",
    closing: "Clôturer cette période",
    handover: "Espèces sorties physiquement lors de la remise (TND)",
    handoverWarning: "La remise reste une déclaration, pas une preuve de réception par un tiers.",
    accept: "J'ai vérifié les tentatives, l'écart et le montant à remettre. Je comprends que la clôture ouvre la période suivante.",
    close: "Confirmer la clôture",
    latest: "Dernière tentative",
    history: "Historique des comptages enregistrés",
    attemptLabel: "Comptage n°",
    firstCount: "Premier comptage — aucun motif de recomptage",
    recountDetail: "Motif du recomptage",
    recordedBy: "Identifiant du compteur (audit logiciel)",
    submittedAt: "Horodatage enregistré (serveur)",
    independenceDetail: "Détail du contrôle logiciel (sans preuve physique)",
    afterWarning: "Des espèces ont été enregistrées après le dernier comptage. Elles ne sont pas incluses dans l’écart affiché et sont reportées sur la période suivante.",
    refreshing: "Relire les données serveur",
    uncertain: "État incertain après la demande. Ne soumettez rien d'autre avant la relecture du serveur.",
    invalid: "Montant invalide. Entrez des dinars avec trois décimales au maximum (ex. 125.500).",
    reasonInvalid: "Un recomptage nécessite un motif de 3 caractères au minimum.",
    savedCount: "Comptage enregistré côté serveur. Revue disponible pour le responsable.",
    savedOpen: "Période ouverte. La caisse est prête pour l'enregistrement des espèces.",
    savedClosed: "Période close et nouvelle période ouverte. La remise n'est pas vérifiée indépendamment.",
    reauth: "Mot de passe requis pour les opérations de gestion de caisse.",
    notProduction: "Données fictives uniquement. Les montants et contrôles ne constituent pas une preuve bancaire ou fiscale.",
  },
  ar: {
    tab: "الصندوق",
    title: "مراقبة الصندوق",
    subtitle: "جرد نقدي اختياري ومراجعة مستقلة للسجلات.",
    blank: "لا توجد فترة صندوق مفتوحة.",
    open: "فتح الفترة الأولى",
    opening: "الرصيد النقدي عند الفتح (دينار)",
    password: "كلمة مرور المسؤول للتحقق من الهوية",
    number: "الفترة",
    attempts: "عدد عمليات الجرد",
    blind: "جرد دون معرفة المتوقع: لا تظهر المبالغ النظرية قبل تسجيل أول جرد.",
    independent: "أدخل النقد الذي تم عده فعليًا. الإدخال الرقمي لا يثبت استقلالية العَد.",
    counted: "النقد الذي تم عده (دينار)",
    reason: "سبب إعادة الجرد (إجباري)",
    entry: "إدخال الجرد",
    submit: "تسجيل الجرد",
    review: "مراجعة الفارق",
    countAgain: "إعادة الجرد",
    compare: "مقارنة السجل مع الجرد",
    expected: "المتوقع حسب السجلات",
    actual: "المعدود فعليًا (إقرار)",
    difference: "الفارق (المعدود ناقص المتوقع)",
    first: "أول فارق",
    evidence: "مستوى الإثبات",
    evidenceSoftware: "تم فحص دور صاحب الجرد برمجيًا، وليس استقلالية الجرد الفعلي.",
    evidenceStaff: "الجرد غير مستقل حسب ضوابط البرنامج.",
    note: "الفارق ليس دليل سرقة. النقد الذي لم يسجل أصلاً لا تكشفه السجلات وحدها.",
    after: "المبالغ النقدية المسجلة بعد الجرد الأخير",
    closing: "إغلاق الفترة",
    handover: "النقد المسلم فعليًا (دينار)",
    handoverWarning: "التسليم المصرح به لا يثبت استلام الطرف الآخر.",
    accept: "تحققت من الجرد والفارق والتسليم وأفهم أن الإغلاق يفتح فترة جديدة.",
    close: "تأكيد الإغلاق",
    latest: "آخر محاولة",
    history: "سجل عمليات الجرد المسجلة",
    attemptLabel: "الجرد رقم",
    firstCount: "الجرد الأول — لا يوجد سبب لإعادة الجرد",
    recountDetail: "سبب إعادة الجرد",
    recordedBy: "معرّف الشخص الذي أجرى الجرد (سجل النظام)",
    submittedAt: "وقت تسجيل الجرد (الخادم)",
    independenceDetail: "تفاصيل الفحص البرمجي (لا يثبت الجرد الفعلي)",
    afterWarning: "سُجّلت مبالغ نقدية بعد آخر جرد. لا تدخل في الفارق المعروض وتُرحّل إلى الفترة التالية.",
    refreshing: "إعادة القراءة من الخادم",
    uncertain: "النتيجة غير مؤكدة. لا تسجل عملية أخرى قبل مراجعة حالة الخادم.",
    invalid: "مبلغ غير صحيح. أدخل الدينار بثلاث خانات عشرية كحد أقصى.",
    reasonInvalid: "إعادة الجرد تحتاج سببًا لا يقل عن 3 أحرف.",
    savedCount: "تم تسجيل الجرد بالخادم. يمكن للمسؤول مراجعة الفارق.",
    savedOpen: "تم فتح الفترة. يمكن تسجيل العمليات النقدية.",
    savedClosed: "أغلقت الفترة وفتحت فترة جديدة. التسليم غير محقق مستقلاً.",
    reauth: "كلمة المرور مطلوبة لإدارة الصندوق.",
    notProduction: "بيانات تجريبية فقط. هذه الأرقام ليست إثباتًا بنكيًا أو جبائيًا.",
  },
} as const;

export function OwnerCashControl({ api, lang, w }: { api: Api; lang: Lang; w: Words }) {
  const t = cashText[lang];
  const [mode, setMode] = useState<"count" | "review">("count");
  const resource = useResource(useCallback(async (signal: AbortSignal) => {
    const current = await api.ownerCashPeriod(signal);
    const review = mode === "review" && current.period && current.period.countAttempts > 0
      ? await api.ownerCashReview(current.period.id, signal) : undefined;
    return { period: current.period, review };
  }, [api, mode]));

  const [opening, setOpening] = useState("0");
  const [counted, setCounted] = useState("");
  const [reason, setReason] = useState("");
  const [handover, setHandover] = useState("0");
  const [password, setPassword] = useState("");
  const [confirmClose, setConfirmClose] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState<unknown>();
  const [validation, setValidation] = useState("");
  const [notice, setNotice] = useState("");
  const lock = useRef(false);

  // An uncertain write remains blocked until a fresh successful authoritative GET.
  useEffect(() => {
    if (!resource.loading && resource.data) setUncertain(false);
  }, [resource.data, resource.loading]);

  const refresh = () => {
    if (lock.current) return;
    setNotice("");
    setError(undefined);
    setValidation("");
    resource.refresh();
  };

  async function safeWrite(op: () => Promise<void>) {
    if (lock.current || uncertain || resource.loading || resource.error || !resource.data) return;
    lock.current = true;
    setBusy(true);
    setValidation("");
    setError(undefined);
    setNotice("");
    try {
      await op();
    } catch (cause) {
      setError(cause);
      if (cause instanceof ApiError &&
        (cause.code === "NETWORK" || cause.code === "INVALID_RESPONSE" || cause.status >= 500)) {
        setUncertain(true);
      }
    } finally {
      setPassword("");
      setBusy(false);
      lock.current = false;
    }
  }

  function parsed(value: string): number | null {
    try { return parseDrawerMillimes(value); }
    catch { setValidation(t.invalid); return null; }
  }

  async function openPeriod(event: FormEvent) {
    event.preventDefault();
    const amountMillimes = parsed(opening);
    if (amountMillimes === null || !password) return;
    await safeWrite(async () => {
      await api.reauthenticate(password);
      await api.openCashPeriod(amountMillimes, crypto.randomUUID());
      setNotice(t.savedOpen);
      resource.refresh();
    });
  }

  async function submitCount(event: FormEvent) {
    event.preventDefault();
    const period = resource.data?.period;
    if (!period) return;
    const sum = parsed(counted);
    if (sum === null) return;
    if (period.countAttempts > 0 && (reason.trim().length < 3 || reason.trim().length > 200)) {
      setValidation(t.reasonInvalid);
      return;
    }
    await safeWrite(async () => {
      await api.submitCashCount(period.id, sum,
        period.countAttempts ? reason.trim() : undefined, crypto.randomUUID());
      setCounted("");
      setReason("");
      setNotice(t.savedCount);
      setMode("review");
      resource.refresh();
    });
  }

  async function closePeriod(event: FormEvent) {
    event.preventDefault();
    const review = resource.data?.review;
    const period = resource.data?.period;
    const last = review?.attempts.at(-1);
    if (!period || !last || !confirmClose || !password || review?.period.id !== period.id) return;
    const amt = parsed(handover);
    if (amt === null || amt > last.countedMillimes) {
      setValidation(t.invalid);
      return;
    }
    await safeWrite(async () => {
      await api.reauthenticate(password);
      await api.closeCashPeriod(period.id, last.id, amt, undefined, crypto.randomUUID());
      setMode("count");
      setHandover("0");
      setConfirmClose(false);
      setNotice(t.savedClosed);
      resource.refresh();
    });
  }

  const period = resource.data?.period;
  const review = resource.data?.review;
  const blocked = busy || uncertain || resource.loading || !!resource.error;
  const latest = review?.attempts.at(-1);

  return (
    <section className="board-panel owner-cash" aria-label={t.title}>
      <div className="panel-heading">
        <div><h2>{t.title}</h2><p>{t.subtitle}</p></div>
        <button className="secondary" type="button" disabled={busy} onClick={refresh}>{t.refreshing}</button>
      </div>
      <div className="cash-body">
        <p className="warning">{t.notProduction}</p>
        {uncertain && <p className="uncertain" role="alert">{t.uncertain}</p>}
        {error !== undefined && <ErrorBox error={error} w={w} />}
        {resource.error !== undefined && <ErrorBox error={resource.error} w={w} />}
        {validation && <p role="alert" className="warning">{validation}</p>}
        {notice && <p role="status" className="toast">{notice}</p>}
        {resource.loading ? <Loading label={w.loading} /> : resource.error ? null : !period ? (
          <form onSubmit={e => void openPeriod(e)} className="cash-form">
            <p>{t.blank}</p>
            <p className="muted">{t.reauth}</p>
            <label>{t.opening}
              <input dir="ltr" inputMode="decimal" value={opening} onChange={e => setOpening(e.target.value)} required disabled={blocked} />
            </label>
            <label>{t.password}
              <input type="password" autoComplete="current-password" value={password}
                onChange={e => setPassword(e.target.value)} required disabled={blocked} />
            </label>
            <button className="primary" disabled={blocked || !password} type="submit">{busy ? w.saving : t.open}</button>
          </form>
        ) : (
          <>
            <dl className="checkout-summary">
              <dt>{t.number}</dt><dd>{period.periodNo}</dd>
              <dt>{t.attempts}</dt><dd data-testid="cash-attempt-count">{period.countAttempts}</dd>
            </dl>
            <div className="cash-view-tabs">
              <button className="secondary" type="button" disabled={blocked || mode === "count"} onClick={() => setMode("count")}>
                {period.countAttempts ? t.countAgain : t.entry}
              </button>
              {period.countAttempts > 0 &&
                <button className="secondary" type="button" disabled={blocked || mode === "review"} onClick={() => setMode("review")}>{t.review}</button>}
            </div>
            {mode === "count" ? (
              <form onSubmit={e => void submitCount(e)} className="cash-form">
                <p className="warning" role="status">{t.blind}</p>
                <p>{t.independent}</p>
                <label>{t.counted}
                  <input inputMode="decimal" dir="ltr" value={counted} onChange={e => setCounted(e.target.value)}
                    required disabled={blocked} data-testid="cash-count-amount" />
                </label>
                {period.countAttempts > 0 &&
                  <label>{t.reason}
                    <textarea maxLength={200} value={reason} onChange={e => setReason(e.target.value)}
                      required disabled={blocked} />
                  </label>}
                <button className="primary" disabled={blocked || !counted.trim() ||
                  (period.countAttempts > 0 && reason.trim().length < 3)} type="submit">
                  {busy ? w.saving : t.submit}
                </button>
              </form>
            ) : review && latest ? (
              <div>
                <h3>{t.compare}</h3>
                <dl className="cash-figures">
                  <dt>{t.expected}</dt><dd data-testid="cash-expected"><bdi>{amount(latest.expectedMillimes)}</bdi></dd>
                  <dt>{t.actual}</dt><dd data-testid="cash-counted"><bdi>{amount(latest.countedMillimes)}</bdi></dd>
                  <dt>{t.difference}</dt><dd data-testid="cash-difference"><bdi>{amount(latest.differenceMillimes)}</bdi></dd>
                  <dt>{t.first}</dt><dd><bdi>{amount(review.attempts[0]!.differenceMillimes)}</bdi></dd>
                </dl>
                <p>{t.evidence}: {latest.counterIndependent ? t.evidenceSoftware : t.evidenceStaff}</p>
                <p className="warning">{t.note}</p>
                <p>{t.after}: <bdi>{review.cashRecordedAfterLatestCount.count}</bdi> · <bdi>{amount(review.cashRecordedAfterLatestCount.totalMillimes)}</bdi></p>
                {review.cashRecordedAfterLatestCount.count > 0 &&
                  <p className="warning" role="status">{t.afterWarning}</p>}
                <section aria-label={t.history}>
                  <h3>{t.history}</h3>
                  <ol className="cash-attempt-list" data-testid="cash-attempt-history">
                    {review.attempts.map(attempt => (
                      <li className="cash-attempt" key={attempt.id}>
                        <h4>{t.attemptLabel} <bdi>{attempt.attemptNo}</bdi>{attempt.id === latest.id && <> · {t.latest}</>}</h4>
                        <dl className="cash-figures">
                          <dt>{t.actual}</dt><dd><bdi>{amount(attempt.countedMillimes)}</bdi></dd>
                          <dt>{t.difference}</dt><dd><bdi>{amount(attempt.differenceMillimes)}</bdi></dd>
                        </dl>
                        <p>{t.recountDetail}: {attempt.recountReason ?? t.firstCount}</p>
                        <p>{t.recordedBy}: <bdi>{attempt.countedBy}</bdi></p>
                        <p>{t.submittedAt}: <time dateTime={attempt.submittedAt}><bdi>{clinicPaymentTime(attempt.submittedAt, lang, "UTC")} UTC</bdi></time></p>
                        <p>{t.evidence}: {attempt.counterIndependent ? t.evidenceSoftware : t.evidenceStaff}</p>
                        <p>{t.independenceDetail}: <bdi>{cashIndependenceNotes(attempt.independenceNotes, lang)}</bdi></p>
                      </li>
                    ))}
                  </ol>
                </section>
                <section className="cash-close">
                  <h3>{t.closing}</h3>
                  <p className="muted">{t.handoverWarning}</p>
                  <form className="cash-form" onSubmit={e => void closePeriod(e)}>
                    <label>{t.handover}
                      <input inputMode="decimal" dir="ltr" value={handover} onChange={e => setHandover(e.target.value)}
                        disabled={blocked} required />
                    </label>
                    <label>{t.password}
                      <input type="password" autoComplete="current-password" value={password}
                        onChange={e => setPassword(e.target.value)} disabled={blocked} required />
                    </label>
                    <label className="check-label">
                      <input type="checkbox" checked={confirmClose} onChange={e => setConfirmClose(e.target.checked)}
                        disabled={blocked} /> {t.accept}
                    </label>
                    <button className="primary" type="submit" disabled={blocked || !password || !confirmClose}>{t.close}</button>
                  </form>
                </section>
              </div>
            ) : <Loading label={w.loading} />}
          </>
        )}
      </div>
    </section>
  );
}
