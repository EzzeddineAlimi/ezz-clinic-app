import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Api, ApiError } from "./api.ts";
import type { Visit } from "./api.ts";
import type { Words } from "./i18n.ts";
import { amount, PaymentIntent, tndToMillimes } from "./billing.ts";
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
    save: "Enregistrer le paiement",
    receipt: "Reçu",
    print: "Préparer une impression",
    paper: "Imprimer ce document",
    restart: "Nouvelle intention après refus confirmé",
    reconcile: "Relire le solde et les paiements",
    uncertain:
      "Résultat incertain. Vérifiez les paiements, puis réessayez avec la même intention. Ne créez pas un second paiement.",
    desk: "Enregistrement accueil uniquement — espèces et carte non vérifiées indépendamment.",
    closed:
      "Caisse indisponible : le responsable doit ouvrir une période. Paiement espèces bloqué.",
    invalid: "Montant invalide ou supérieur au solde.",
    duplicate:
      "Paiement similaire détecté. Vérifiez l’historique avant toute nouvelle intention.",
    duplicateConfirm:
      "Ceci est réellement un DEUXIÈME paiement distinct du premier, pour le même montant et mode. Je l’ai vérifié dans l’historique.",
    gate: "Soins non confirmés : encaissement bloqué.",
    empty: "Aucun paiement.",
    notice:
      "DONNÉES FICTIVES — DOCUMENT NON FISCAL. Exigences légales non vérifiées.",
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
    save: "تسجيل الدفعة",
    receipt: "إيصال",
    print: "إعداد نسخة للطباعة",
    paper: "طباعة هذه الوثيقة",
    restart: "عملية جديدة بعد رفض مؤكد",
    reconcile: "مراجعة الرصيد والدفعات",
    uncertain:
      "النتيجة غير مؤكدة. راجعوا الدفعات ثم أعيدوا المحاولة بنفس العملية. لا تسجلوا دفعة ثانية.",
    desk: "تسجيل الاستقبال فقط — النقد والبطاقة غير متحقق منهما بشكل مستقل.",
    closed: "الصندوق غير متاح: يجب على المسؤول فتح فترة. الدفع النقدي ممنوع.",
    invalid: "المبلغ غير صحيح أو يتجاوز الرصيد.",
    duplicate: "تم رصد دفعة مماثلة. راجعوا السجل قبل عملية جديدة.",
    duplicateConfirm:
      "هذه دفعة ثانية مستقلة فعلاً عن الدفعة السابقة بنفس المبلغ وطريقة الدفع. راجعت السجل وأؤكدها.",
    gate: "العلاجات غير مؤكدة: الدفع ممنوع.",
    empty: "لا توجد دفعات.",
    notice:
      "بيانات وهمية — ليست وثيقة جبائية. المتطلبات القانونية غير متحقق منها.",
  },
};
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
  const lang = w.checkout === text.ar.title ? "ar" : "fr",
    t = text[lang];
  const data = useResource(
    useCallback(
      async (signal: AbortSignal) => {
        const [b, h, c] = await Promise.all([
          api.balance(visit.id, signal),
          api.payments(visit.id, signal),
          api.cashPeriod(signal),
        ]);
        return { ...b, ...h, cashOpen: !!c.period };
      },
      [api, visit.id],
    ),
  );
  const [value, setValue] = useState(""),
    [tender, setTender] = useState<"" | "CASH" | "CARD">(""),
    [intent, setIntent] = useState(() => new PaymentIntent()),
    [attempted, setAttempted] = useState(false),
    [duplicateDenied, setDuplicateDenied] = useState(false),
    [duplicateApproved, setDuplicateApproved] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState<unknown>(),
    [validation, setValidation] = useState(""),
    [receiptId, setReceiptId] = useState(""),
    [receipt, setReceipt] = useState<Awaited<ReturnType<Api["receipt"]>>>(),
    [printDoc, setPrintDoc] =
      useState<Awaited<ReturnType<Api["printReceipt"]>>>();
  const busy = useRef(false),
    printIntent = useRef<{ key: string; lang: string } | undefined>(undefined);
  function report(cause: unknown) {
    setError(cause);
    if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) {
      setReceipt(undefined);
      setPrintDoc(undefined);
      data.refresh();
    }
  }
  async function pay(e: FormEvent) {
    e.preventDefault();
    if (busy.current) return;
    let body;
    try {
      if (!tender) throw new Error();
      const candidate = {
        amountMillimes: tndToMillimes(value),
        tender,
        ...(duplicateDenied && duplicateApproved ? { confirmDuplicate: true } : {}),
      };
      if (!uncertain && duplicateDenied && !duplicateApproved) throw new Error();
      if (
        !uncertain &&
        (!data.data?.balance.careConfirmed ||
          candidate.amountMillimes > data.data.balance.balanceMillimes)
      )
        throw new Error();
      body = intent.payload(candidate);
    } catch {
      setValidation(t.invalid);
      return;
    }
    busy.current = true;
    setPending(true);
    setAttempted(true);
    setError(undefined);
    setValidation("");
    try {
      const r = await api.payment(visit.id, body, intent.key);
      setUncertain(false);
      setReceiptId(r.receipt.id);
      data.refresh();
    } catch (e) {
      report(e);
      if (e instanceof ApiError && e.code === "POSSIBLE_DUPLICATE_PAYMENT") {
        // A confirmed denial: never reuse its key with a changed body.
        // A new intent may be made only after the staff explicitly reviews history.
        setDuplicateDenied(true);
        setDuplicateApproved(false);
      }
      setUncertain(
        (old) =>
          old ||
          (e instanceof ApiError &&
            (e.code === "NETWORK" || e.status >= 500 || e.status === 0)),
      );
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  async function loadReceipt() {
    setError(undefined);
    try {
      setReceipt(await api.receipt(receiptId));
    } catch (e) {
      report(e);
    }
  }
  useEffect(() => {
    if (receiptId) void loadReceipt();
  }, [receiptId]);
  async function prepare() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(undefined);
    printIntent.current ??= { key: crypto.randomUUID(), lang };
    try {
      setPrintDoc(
        await api.printReceipt(
          receiptId,
          printIntent.current.lang,
          printIntent.current.key,
        ),
      );
      printIntent.current = undefined;
    } catch (e) {
      report(e);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  return (
    <Modal title={t.title} w={w} busy={pending || uncertain} close={close}>
      <div className="patient-context">
        <strong>
          <bdi>{nameOf(visit.patient)}</bdi> · #{visit.patient.fileNo}
        </strong>
      </div>
      <p>{t.desk}</p>
      {error !== undefined && <ErrorBox error={error} w={w} />}
      {error instanceof ApiError && error.code === "NO_OPEN_CASH_PERIOD" && (
        <p role="alert">{t.closed}</p>
      )}
      {duplicateDenied && !receiptId && (
        <div role="group" aria-label={t.duplicate}>
          <p role="alert">{t.duplicate}</p>
          <label>
            <input type="checkbox" checked={duplicateApproved}
              disabled={pending || uncertain || attempted}
              onChange={e => setDuplicateApproved(e.target.checked)} />
            {t.duplicateConfirm}
          </label>
        </div>
      )}
      {validation && <p role="alert">{validation}</p>}
      {uncertain && (
        <p className="uncertain" role="alert">
          {t.uncertain}
        </p>
      )}
      <button className="secondary" disabled={pending} onClick={data.refresh}>
        {t.reconcile}
      </button>
      {data.loading ? (
        <Loading label={w.loading} />
      ) : data.error ? (
        <ErrorBox error={data.error} w={w} />
      ) : (
        data.data && (
          <>
            <dl className="checkout-summary">
              <dt>{t.total}</dt>
              <dd>{amount(data.data.balance.chargedMillimes)}</dd>
              <dt>{t.balance}</dt>
              <dd data-testid="checkout-balance">
                {amount(data.data.balance.balanceMillimes)}
              </dd>
            </dl>
            <h3>{t.paid}</h3>
            {!data.data.payments.length && <p>{t.empty}</p>}
            <ul>
              {data.data.payments.map((p) => (
                <li key={p.id}>
                  <bdi>
                    {amount(p.amountMillimes)} ·{" "}
                    {p.tender === "CASH" ? t.cash : t.card} ·{" "}
                    {p.receiptNumber ?? "—"} · {p.recordedAt}
                  </bdi>
                </li>
              ))}
            </ul>
            {!data.data.balance.careConfirmed && <p role="alert">{t.gate}</p>}
            {!data.data.cashOpen && <p role="alert">{t.closed}</p>}
            {!receiptId && (
              <form onSubmit={(e) => void pay(e)}>
                <fieldset disabled={pending || attempted} className="form-grid">
                  <label>
                    {t.amount}
                    <input
                      inputMode="decimal"
                      dir="ltr"
                      required
                      value={value}
                      onChange={(e) => setValue(e.target.value)}
                    />
                  </label>
                  <label>
                    {t.tender}
                    <select
                      required
                      value={tender}
                      onChange={(e) =>
                        setTender(e.target.value as typeof tender)
                      }
                    >
                      <option value="">{t.choose}</option>
                      <option value="CASH">{t.cash}</option>
                      <option value="CARD">{t.card}</option>
                    </select>
                  </label>
                </fieldset>
                <footer className="form-footer">
                  <button
                    className="primary"
                    disabled={
                      pending ||
                      (!uncertain &&
                        (attempted ||
                          (duplicateDenied && !duplicateApproved) ||
                          !data.data.balance.careConfirmed ||
                          data.data.balance.balanceMillimes <= 0 ||
                          (tender === "CASH" && !data.data.cashOpen)))
                    }
                  >
                    {pending ? w.saving : uncertain ? w.retry : t.save}
                  </button>
                </footer>
              </form>
            )}
            {attempted && !uncertain && !receiptId && (
              <button
                className="secondary"
                onClick={() => {
                  setIntent(new PaymentIntent());
                  setAttempted(false);
                  setDuplicateApproved(false);
                  setError(undefined);
                  data.refresh();
                }}
              >
                {t.restart}
              </button>
            )}
          </>
        )
      )}
      {receiptId && !receipt && (
        <button className="primary" onClick={() => void loadReceipt()}>
          {t.receipt} · {w.refresh}
        </button>
      )}
      {data.data && receipt && (
        <section className="receipt-preview">
          <h3>
            {t.receipt} <bdi>{receipt.receipt.snapshot.label}</bdi>
          </h3>
          <p>{t.notice}</p>
          <p>
            <bdi>
              {receipt.receipt.snapshot.patient.name} · #
              {receipt.receipt.snapshot.patient.fileNo}
            </bdi>
          </p>
          <p>
            {t.amount}: {amount(receipt.receipt.snapshot.amountMillimes)}
          </p>
          <p>
            {t.balance}: {amount(receipt.receipt.snapshot.balanceAfterMillimes)}
          </p>
          <button
            className="primary"
            disabled={pending}
            onClick={() => void prepare()}
          >
            {t.print}
          </button>
        </section>
      )}
      {data.data && printDoc && (
        <>
          <div id="receipt-print">
            {printDoc.document.sections.map((s) => (
              <section key={s.lang} lang={s.lang} dir={s.dir}>
                <h2>
                  {s.title} · {s.mark}
                </h2>
                <p>{s.notice}</p>
                <dl>
                  {s.lines.map((l) => (
                    <div key={l.key}>
                      <dt>{l.label}</dt>
                      <dd>
                        <bdi>{l.value}</bdi>
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
          <button
            className="secondary"
            onClick={() => {
              window.print();
              setPrintDoc(undefined);
            }}
          >
            {t.paper}
          </button>
        </>
      )}
    </Modal>
  );
}
