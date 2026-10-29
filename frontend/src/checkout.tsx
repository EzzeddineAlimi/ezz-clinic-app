import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Api, ApiError } from "./api.ts";
import type { Visit } from "./api.ts";
import type { Words } from "./i18n.ts";
import { amount, tndToMillimes } from "./billing.ts";
import type { DurableIntent } from "./recovery.ts";
import { historyMatchesRecovery } from "./recovery.ts";
import { ErrorBox, Loading, Modal, useResource } from "./ui.tsx";
import { nameOf } from "./forms.tsx";

const text = {
  fr: {
    title: "Encaissement",
    total: "Soins confirmés",
    balance: "Reste à payer",
    paid: "Paiements enregistrés",
    amount: "Montant (TND)",
    tender: "Mode de paiement",
    choose: "Choisir",
    cash: "Espèces",
    card: "Carte",
    prepare: "Préparer le paiement",
    record: "Confirmer l’encaissement",
    reviewHistory: "J’ai vérifié les paiements enregistrés ci-dessus.",
    received: "Je confirme que ce paiement distinct a réellement été reçu.",
    receipt: "Reçu",
    openReceipt: "Voir le reçu",
    print: "Préparer une impression",
    paper: "Imprimer ce document",
    printUnknown: "Préparation de document uniquement : impression et remise au patient non confirmées.",
    reconcile: "Relire le solde et les paiements",
    pending: "Paiement en attente de décision — aucun nouveau paiement ne peut être préparé.",
    original: "Intention originale, non modifiable",
    creator: "Créée par",
    alreadyRecorded: "Enregistrement confirmé côté serveur. Le reçu reste accessible dans l’historique.",
    historyMismatch: "L’historique ne correspond pas à l’état du serveur. Actualisez avant toute action.",
    uncertain: "Réponse incertaine. Ne créez pas un nouveau paiement. Relisez l’état serveur avant de continuer.",
    cancel: "Annuler cette intention (aucun remboursement)",
    cancelledReason: "Raison de l’annulation",
    notReceived: "Après vérification, je confirme que ce paiement n’a pas été enregistré via cette intention et ne doit pas être enregistré.",
    desk: "Enregistrement accueil uniquement — espèces et carte non vérifiées indépendamment.",
    closed: "Caisse indisponible : le responsable doit ouvrir une période. Paiement espèces bloqué.",
    invalid: "Montant invalide ou supérieur au solde.",
    duplicate: "Paiement similaire détecté. Vérifiez l’historique : cette opération est-elle réellement distincte ?",
    duplicateConfirm: "C’est un DEUXIÈME paiement distinct du premier, vérifié dans l’historique.",
    gate: "Soins non confirmés : encaissement bloqué.",
    empty: "Aucun paiement.",
    notice: "DONNÉES FICTIVES — DOCUMENT NON FISCAL. Exigences légales non vérifiées.",
    recoveryError: "Impossible de vérifier l’état du paiement : aucun nouvel encaissement n’est autorisé.",
  },
  ar: {
    title: "استخلاص",
    total: "العلاجات المؤكدة",
    balance: "المبلغ المتبقي",
    paid: "الدفعات المسجلة",
    amount: "المبلغ (دينار)",
    tender: "طريقة الدفع",
    choose: "اختيار",
    cash: "نقدًا",
    card: "بطاقة",
    prepare: "تحضير الدفعة",
    record: "تأكيد تسجيل الدفعة",
    reviewHistory: "راجعت الدفعات المسجلة أعلاه.",
    received: "أؤكد أن هذه دفعة مستقلة تم استلامها فعلاً.",
    receipt: "إيصال",
    openReceipt: "عرض الإيصال",
    print: "إعداد نسخة للطباعة",
    paper: "طباعة هذه الوثيقة",
    printUnknown: "تم إعداد الوثيقة فقط؛ الطباعة الفعلية وتسليمها للمريض غير مؤكدتين.",
    reconcile: "إعادة قراءة الرصيد والدفعات",
    pending: "هناك دفعة معلقة — لا يمكن تحضير دفعة جديدة.",
    original: "العملية الأصلية غير قابلة للتعديل",
    creator: "أُنشئت من طرف",
    alreadyRecorded: "تم تسجيل الدفعة على الخادم؛ يمكن الوصول للإيصال من السجل.",
    historyMismatch: "السجل لا يطابق حالة الخادم. يجب التحديث قبل أي إجراء.",
    uncertain: "النتيجة غير مؤكدة. لا تنشئ دفعة جديدة. راجع حالة الخادم أولاً.",
    cancel: "إلغاء العملية المعلقة (ليس استردادًا)",
    cancelledReason: "سبب الإلغاء",
    notReceived: "بعد التحقق، أؤكد عدم تسجيل هذه الدفعة عبر العملية المعلقة وأنه لا يجب تسجيلها.",
    desk: "تسجيل الاستقبال فقط — النقد والبطاقة غير متحقق منهما بشكل مستقل.",
    closed: "الصندوق مغلق: يجب على المسؤول فتح فترة. الدفع النقدي ممنوع.",
    invalid: "المبلغ غير صحيح أو يتجاوز الرصيد.",
    duplicate: "تم اكتشاف دفعة مماثلة. راجع السجل للتأكد أنها دفعة مختلفة فعلاً.",
    duplicateConfirm: "هذه دفعة ثانية مستقلة، وقد تحققت من سجل الدفعات.",
    gate: "العلاجات غير مؤكدة: الدفع ممنوع.",
    empty: "لا توجد دفعات.",
    notice: "بيانات وهمية — ليست وثيقة جبائية. المتطلبات القانونية غير متحقق منها.",
    recoveryError: "تعذر التحقق من حالة الدفعة؛ تسجيل دفعة جديدة ممنوع.",
  },
};

function isUnknown(error: unknown) {
  return error instanceof ApiError &&
    (error.code === "NETWORK" || error.code === "INVALID_RESPONSE" ||
      error.status === 0 || error.status >= 500);
}

export function Checkout({
  api,
  visit,
  w,
  close,
}: {
  api: Api;
  visit: Visit;
  w: Words;
  close: () => void;
}) {
  const lang = w.checkout === text.ar.title ? "ar" : "fr";
  const t = text[lang];
  const data = useResource(
    useCallback(async (signal: AbortSignal) => {
      // Read coherence comes from the locked server recovery endpoint. Never
      // treat a separately fetched history as the same snapshot without checking IDs.
      const [recovery, history, cash] = await Promise.all([
        api.paymentRecovery(visit.id, signal),
        api.payments(visit.id, signal),
        api.cashPeriod(signal),
      ]);
      return {
        recovery,
        history,
        cashOpen: !!cash.period,
        consistent: historyMatchesRecovery(recovery, history.payments),
      };
    }, [api, visit.id]),
  );
  const refreshRef = useRef(data.refresh);
  refreshRef.current = data.refresh;
  useEffect(() => {
    const refresh = () => refreshRef.current();
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("online", refresh);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", refresh);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const [value, setValue] = useState("");
  const [tender, setTender] = useState<"" | "CASH" | "CARD">("");
  const [reviewed, setReviewed] = useState(false);
  const [received, setReceived] = useState(false);
  const [notReceived, setNotReceived] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [prepared, setPrepared] = useState<{ id: string; payload: { amountMillimes: number; tender: "CASH" | "CARD" }; status: "PENDING" }>();
  const [duplicateDenied, setDuplicateDenied] = useState(false);
  const [duplicateApproved, setDuplicateApproved] = useState(false);
  const [needsRecovery, setNeedsRecovery] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [validation, setValidation] = useState("");
  const [receiptId, setReceiptId] = useState("");
  const [receipt, setReceipt] = useState<Awaited<ReturnType<Api["receipt"]>>>();
  const [printDoc, setPrintDoc] = useState<Awaited<ReturnType<Api["printReceipt"]>>>();
  const busy = useRef(false);
  const printKey = useRef<{ id: string; key: string; lang: string } | undefined>(undefined);

  useEffect(() => {
    if (!data.data || data.loading) return;
    // Any newly read ledger requires a fresh, explicit human review.
    setReviewed(false);
    setReceived(false);
    setNotReceived(false);
    setNeedsRecovery(!data.data.consistent);
    const serverPending = data.data.recovery.intentions.find(i => i.status === "PENDING");
    setPrepared(serverPending ? {
      id: serverPending.id,
      payload: serverPending.payload,
      status: "PENDING",
    } : undefined);
  }, [data.data, data.loading]);

  useEffect(() => {
    setReceipt(undefined);
    setPrintDoc(undefined);
    if (!receiptId) return;
    let active = true;
    void api.receipt(receiptId).then(
      r => { if (active) setReceipt(r); },
      e => { if (active) setError(e); },
    );
    return () => { active = false; };
  }, [api, receiptId]);

  function report(cause: unknown) {
    setError(cause);
    if (isUnknown(cause)) {
      setNeedsRecovery(true);
    }
    if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) {
      setReceipt(undefined);
      setPrintDoc(undefined);
      setPrepared(undefined);
      setNeedsRecovery(true);
    }
  }

  function recheck() {
    setError(undefined);
    setReviewed(false);
    setReceived(false);
    setNotReceived(false);
    setPrintDoc(undefined);
    data.refresh();
  }

  async function guarded(action: () => Promise<void>) {
    if (busy.current || needsRecovery || data.loading || !data.data?.consistent) return;
    busy.current = true;
    setPending(true);
    setError(undefined);
    setValidation("");
    try {
      await action();
    } catch (cause) {
      report(cause);
      // A completed 409 is not evidence of a successful payment. Refresh first.
      if (cause instanceof ApiError && cause.status === 409) data.refresh();
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  async function preparePayment(e: FormEvent) {
    e.preventDefault();
    if (!data.data || prepared || !reviewed || pending || needsRecovery) return;
    let millimes: number;
    try {
      millimes = tndToMillimes(value);
      if (!tender ||
        !data.data.recovery.balance.careConfirmed ||
        millimes > data.data.recovery.balance.balanceMillimes ||
        (tender === "CASH" && !data.data.cashOpen) ||
        ((duplicateDenied || matchingPrior) && !duplicateApproved)
      ) throw new Error("INVALID");
    } catch {
      setValidation(t.invalid);
      return;
    }
    await guarded(async () => {
      try {
        const result = await api.preparePayment(visit.id, {
          amountMillimes: millimes,
          tender: tender as "CASH" | "CARD",
          recoveryVersion: data.data!.recovery.recoveryVersion,
          acknowledgedPaymentIds: [...data.data!.recovery.paymentIds],
          ...((duplicateDenied || matchingPrior) && duplicateApproved ? { confirmDuplicate: true } : {}),
        }, crypto.randomUUID());
        setPrepared(result.intent);
        setReviewed(false);
        setDuplicateDenied(false);
        setDuplicateApproved(false);
        data.refresh();
      } catch (cause) {
        if (cause instanceof ApiError && cause.code === "POSSIBLE_DUPLICATE_PAYMENT") {
          setDuplicateDenied(true);
          setDuplicateApproved(false);
        }
        throw cause;
      }
    });
  }

  async function recordPayment(intent: { id: string }) {
    if (!received || !reviewed) return;
    await guarded(async () => {
      const result = await api.recordPaymentIntent(intent.id, crypto.randomUUID());
      setReceiptId(result.receipt.id);
      setPrepared(undefined);
      setReceived(false);
      setReviewed(false);
      data.refresh();
    });
  }

  async function cancelPayment(intent: { id: string }) {
    if (!notReceived || !reviewed || cancelReason.trim().length < 3 ||
        cancelReason.trim().length > 300) return;
    await guarded(async () => {
      await api.cancelPaymentIntent(intent.id, cancelReason.trim(), crypto.randomUUID());
      setPrepared(undefined);
      setNotReceived(false);
      setCancelReason("");
      setReviewed(false);
      data.refresh();
    });
  }

  async function preparePrint() {
    if (!receiptId || busy.current) return;
    busy.current = true;
    setPending(true);
    setError(undefined);
    if (printKey.current?.id !== receiptId) {
      printKey.current = { id: receiptId, key: crypto.randomUUID(), lang };
    }
    try {
      const result = await api.printReceipt(
        receiptId, printKey.current.lang, printKey.current.key,
      );
      setPrintDoc(result);
      printKey.current = undefined;
    } catch (cause) {
      report(cause);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  const recovered = data.data?.recovery;
  const serverPending = recovered?.intentions.find((i: DurableIntent) => i.status === "PENDING");
  const activeIntent = serverPending ?? prepared;
  let matchingPrior = false;
  try {
    const millimes = tndToMillimes(value);
    matchingPrior = !!tender && !!data.data?.history.payments.some(
      p => p.amountMillimes === millimes && p.tender === tender,
    );
  } catch { /* Invalid amount cannot match a prior payment. */ }
  const blocked = pending || data.loading || !!data.error || !data.data?.consistent || needsRecovery;
  return (
    <Modal title={t.title} w={w} busy={pending} close={close}>
      <div className="patient-context">
        <strong><bdi>{nameOf(visit.patient)}</bdi> · #{visit.patient.fileNo}</strong>
      </div>
      <p>{t.desk}</p>
      {error !== undefined && <ErrorBox error={error} w={w} />}
      {validation && <p role="alert">{validation}</p>}
      {needsRecovery && <p role="alert" className="uncertain">{t.uncertain}</p>}
      <button className="secondary" disabled={pending} onClick={recheck}>{t.reconcile}</button>
      {data.loading ? <Loading label={w.loading} /> :
       data.error ? <ErrorBox error={data.error} w={w}><p>{t.recoveryError}</p></ErrorBox> :
       data.data && (
        <>
          {!data.data.consistent && <p role="alert">{t.historyMismatch}</p>}
          <dl className="checkout-summary">
            <dt>{t.total}</dt>
            <dd>{amount(recovered!.balance.chargedMillimes)}</dd>
            <dt>{t.balance}</dt>
            <dd data-testid="checkout-balance">{amount(recovered!.balance.balanceMillimes)}</dd>
          </dl>
          <h3>{t.paid}</h3>
          {!data.data.history.payments.length && <p>{t.empty}</p>}
          <ul>
            {data.data.history.payments.map(p => (
              <li key={p.id}>
                <bdi>{amount(p.amountMillimes)} · {p.tender === "CASH" ? t.cash : t.card} · {p.receiptNumber ?? "—"} · {p.recordedAt}</bdi>
                {p.receiptId && (
                  <> <button className="secondary compact" onClick={() => setReceiptId(p.receiptId!)}>{t.openReceipt}</button></>
                )}
              </li>
            ))}
          </ul>
          {!recovered!.balance.careConfirmed && <p role="alert">{t.gate}</p>}
          {!data.data.cashOpen && <p role="alert">{t.closed}</p>}
          {activeIntent && (
            <section aria-label={t.pending} role="group">
              <p role="alert">{t.pending}</p>
              <p><strong>{t.original}:</strong> {amount(activeIntent.payload.amountMillimes)} · {activeIntent.payload.tender === "CASH" ? t.cash : t.card}</p>
              {"createdBy" in activeIntent && <p>{t.creator}: <bdi>{activeIntent.createdBy}</bdi></p>}
              <p>{t.uncertain}</p>
            </section>
          )}
          {(!!activeIntent || (recovered!.balance.careConfirmed && recovered!.balance.balanceMillimes > 0)) && (
            <label>
              <input type="checkbox" checked={reviewed} disabled={blocked}
                onChange={e => setReviewed(e.target.checked)} />
              {t.reviewHistory}
            </label>
          )}
          {activeIntent ? (
            <>
              <label>
                <input type="checkbox" checked={received} disabled={blocked || !reviewed || notReceived}
                  onChange={e => setReceived(e.target.checked)} />
                {t.received}
              </label>
              <button className="primary" disabled={blocked || !reviewed || !received}
                onClick={() => void recordPayment(activeIntent)}>{pending ? w.saving : t.record}</button>
              <div className="form-grid">
                <label>
                  <input type="checkbox" checked={notReceived} disabled={blocked || !reviewed || received}
                    onChange={e => setNotReceived(e.target.checked)} />
                  {t.notReceived}
                </label>
                <label>{t.cancelledReason}
                  <textarea value={cancelReason} maxLength={300} disabled={blocked || !reviewed || !notReceived}
                    onChange={e => setCancelReason(e.target.value)} />
                </label>
                <button className="secondary" disabled={blocked || !reviewed || !notReceived || cancelReason.trim().length < 3}
                  onClick={() => void cancelPayment(activeIntent)}>{t.cancel}</button>
              </div>
            </>
          ) : (
            recovered!.balance.balanceMillimes > 0 && recovered!.balance.careConfirmed && (
              <form onSubmit={e => void preparePayment(e)}>
                <fieldset disabled={blocked} className="form-grid">
                  <label>{t.amount}
                    <input inputMode="decimal" dir="ltr" required value={value}
                      onChange={e => {
                        setValue(e.target.value);
                        setReviewed(false);
                        setDuplicateDenied(false);
                        setDuplicateApproved(false);
                      }} />
                  </label>
                  <label>{t.tender}
                    <select required value={tender} onChange={e => {
                      setTender(e.target.value as typeof tender);
                      setReviewed(false);
                      setDuplicateDenied(false);
                      setDuplicateApproved(false);
                    }}>
                      <option value="">{t.choose}</option>
                      <option value="CASH">{t.cash}</option>
                      <option value="CARD">{t.card}</option>
                    </select>
                  </label>
                </fieldset>
                {(duplicateDenied || matchingPrior) && (
                  <div role="group" aria-label={t.duplicate}>
                    <p role="alert">{t.duplicate}</p>
                    <label><input type="checkbox" checked={duplicateApproved} disabled={blocked}
                      onChange={e => setDuplicateApproved(e.target.checked)} />{t.duplicateConfirm}</label>
                  </div>
                )}
                <footer className="form-footer">
                  <button className="primary" disabled={blocked || !reviewed || !tender ||
                    (tender === "CASH" && !data.data.cashOpen) ||
                    ((duplicateDenied || matchingPrior) && !duplicateApproved)}>
                    {pending ? w.saving : t.prepare}
                  </button>
                </footer>
              </form>
            )
          )}
          {recovered!.intentions.some(i => i.status === "RECORDED") && <p>{t.alreadyRecorded}</p>}
        </>
      )}
      {receiptId && !receipt && (
        <button className="secondary" disabled={pending} onClick={() => {
          setReceiptId("");
          queueMicrotask(() => setReceiptId(receiptId));
        }}>{t.receipt} · {w.refresh}</button>
      )}
      {receipt && (
        <section className="receipt-preview">
          <h3>{t.receipt} <bdi>{receipt.receipt.snapshot.label}</bdi></h3>
          <p>{t.notice}</p>
          <p><bdi>{receipt.receipt.snapshot.patient.name} · #{receipt.receipt.snapshot.patient.fileNo}</bdi></p>
          <p>{t.amount}: {amount(receipt.receipt.snapshot.amountMillimes)}</p>
          <p>{t.balance}: {amount(receipt.receipt.snapshot.balanceAfterMillimes)}</p>
          <button className="primary" disabled={pending} onClick={() => void preparePrint()}>{t.print}</button>
        </section>
      )}
      {printDoc && (
        <>
          <p role="status">{t.printUnknown}</p>
          <div id="receipt-print">
            {printDoc.document.sections.map(s => (
              <section key={s.lang} lang={s.lang} dir={s.dir}>
                <h2>{s.title} · {s.mark}</h2>
                <p>{s.notice}</p>
                <dl>{s.lines.map(l => (
                  <div key={l.key}><dt>{l.label}</dt><dd><bdi>{l.value}</bdi></dd></div>
                ))}</dl>
              </section>
            ))}
          </div>
          <button className="secondary" onClick={() => {
            window.print();
            setPrintDoc(undefined);
          }}>{t.paper}</button>
        </>
      )}
    </Modal>
  );
}
