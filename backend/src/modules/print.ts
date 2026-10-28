/*
 * PRINT module (B15): printable document CONTRACTS for receipts and paper workflows, in French, Arabic (RTL) or both,
 * normal or large print. Depends on: audit, patients (clinic timezone, shared with B12). Owns no tables (writes receipt_prints rows and audit events).
 *
 * Rules:
 *  - a receipt's first print is the ORIGINAL; every later print is a COPY with its copy number (never a new receipt
 *    number); all prints are logged;
 *  - patient-facing documents carry no clinical content, no internal ids, no staff-only evidence labels and no
 *    adjustment reason codes; a short fingerprint (snapshot SHA-256 prefix) lets the owner match a paper copy to the
 *    system record;
 *  - every document keeps the "fictional / not a fiscal document / requirements unverified" notice in both languages;
 *  - numbers, labels and amounts are bidi-isolated (<bdi dir="ltr">) so RTL text never reorders them;
 *  - all text is HTML-escaped; the HTML is a plain printable sample, not the product's visual design (Astra, B09).
 * Mandatory Tunisian receipt / fee-note fields and Arabic wording are UNVERIFIED: professional and native review needed.
 */
import type { Route } from '../platform/http.ts';
import { fail } from '../platform/errors.ts';
import { isUuid } from '../platform/validate.ts';
import { appendAudit } from './audit.ts';
import { clinicTimezone } from './patients.ts';

export type Lang = 'fr' | 'ar';
export type Size = 'normal' | 'large';
type Text = Record<Lang, string>;

const T = {
  PAYMENT: { fr: 'Reçu de paiement', ar: 'إيصال دفع' },
  REFUND: { fr: 'Reçu de remboursement', ar: 'إيصال استرجاع مبلغ' },
  VOID: { fr: 'Annulation de paiement', ar: 'إلغاء دفع' },
  receiptNo: { fr: 'N° de reçu', ar: 'رقم الإيصال' },
  date: { fr: 'Date', ar: 'التاريخ' },
  clinic: { fr: 'Cabinet', ar: 'العيادة' },
  payee: { fr: 'Bénéficiaire', ar: 'المستفيد' },
  patient: { fr: 'Patient', ar: 'المريض' },
  fileNo: { fr: 'N° de dossier', ar: 'رقم الملف' },
  amountPAYMENT: { fr: 'Montant reçu', ar: 'المبلغ المقبوض' },
  amountREFUND: { fr: 'Montant remboursé', ar: 'المبلغ المسترجع' },
  amountVOID: { fr: 'Montant annulé', ar: 'المبلغ الملغى' },
  tender: { fr: 'Mode de paiement', ar: 'طريقة الدفع' },
  CASH: { fr: 'Espèces', ar: 'نقدًا' },
  CARD: { fr: 'Carte', ar: 'بطاقة' },
  fees: { fr: 'Honoraires', ar: 'الأتعاب' },
  balance: { fr: 'Reste à payer', ar: 'المبلغ المتبقي' },
  voids: { fr: 'Annule le reçu', ar: 'يلغي الإيصال' },
  issuedBy: { fr: 'Établi par', ar: 'حرّره' },
  fingerprint: { fr: 'Empreinte', ar: 'البصمة' },
  ORIGINAL: { fr: 'ORIGINAL', ar: 'أصل' },
  COPY: { fr: 'COPIE', ar: 'نسخة' },
  notice: { fr: 'DONNÉES FICTIVES — CE N\'EST PAS UN DOCUMENT FISCAL. Exigences légales tunisiennes NON VÉRIFIÉES.', ar: 'بيانات وهمية — ليست وثيقة جبائية. المتطلبات القانونية التونسية غير مُتحقَّق منها.' },
} satisfies Record<string, Text>;

const DIR: Record<Lang, 'ltr' | 'rtl'> = { fr: 'ltr', ar: 'rtl' };
const CURRENCY: Text = { fr: 'DT', ar: 'د.ت' };

/** Integer millimes -> "1 234,500 DT" / "1 234,500 د.ت" (comma decimal, 3 digits; Tunisian convention ASSUMED). No floats. */
export function formatAmount(m: number, lang: Lang): string {
  const a = Math.abs(m);
  const dinars = String(Math.floor(a / 1000)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${m < 0 ? '-' : ''}${dinars},${String(a % 1000).padStart(3, '0')} ${CURRENCY[lang]}`;
}

/** ISO instant -> "dd/mm/yyyy HH:MM" in the clinic timezone. */
export function formatLocal(iso: string, timeZone: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(iso)).map(x => [x.type, x.value]));
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

export interface DocLine { key: string; label: string; value: string; isolate: boolean; emphasis?: boolean }
export interface DocSection { lang: Lang; dir: 'ltr' | 'rtl'; title: string; mark: string | null; lines: DocLine[]; notice: string }
export interface PrintDocument { documentType: string; reference: string; size: Size; fontPt: number; sections: DocSection[] }

const langsOf = (lang: string): Lang[] => lang === 'both' ? ['fr', 'ar'] : [lang as Lang];
const fontPt = (size: Size) => size === 'large' ? 18 : 12;

export interface ReceiptSnapshot {
  label: string; kind: 'PAYMENT' | 'REFUND' | 'VOID'; clinic: { name: string }; payee: string; patient: { fileNo: number; name: string };
  issuedAt: string; issuedBy: string; amountMillimes: number; tender: 'CASH' | 'CARD'; chargedMillimes?: number; balanceAfterMillimes?: number; voidsReceiptNumber?: number | null;
}

/** Receipt snapshot -> print document. Only whitelisted fields are printed. */
export function receiptDocument(s: ReceiptSnapshot, sha256: string, o: { lang: string; size: Size; copyNo: number; timeZone: string }): PrintDocument {
  const sections = langsOf(o.lang).map(lang => {
    const line = (key: string, label: Text, value: string, isolate = true, emphasis = false): DocLine => ({ key, label: label[lang], value, isolate, emphasis });
    const lines: DocLine[] = [
      line('receiptNo', T.receiptNo, s.label, true, true),
      line('date', T.date, formatLocal(s.issuedAt, o.timeZone)),
      line('clinic', T.clinic, s.clinic.name, false),
      line('payee', T.payee, s.payee, false),
      line('patient', T.patient, s.patient.name, false),
      line('fileNo', T.fileNo, String(s.patient.fileNo)),
      line('amount', T[`amount${s.kind}`], formatAmount(s.amountMillimes, lang), true, true),
      line('tender', T.tender, T[s.tender][lang], false),
    ];
    if (s.kind === 'PAYMENT' && s.chargedMillimes !== undefined) lines.push(line('fees', T.fees, formatAmount(s.chargedMillimes, lang)));
    if (s.kind === 'PAYMENT' && s.balanceAfterMillimes !== undefined) lines.push(line('balance', T.balance, formatAmount(s.balanceAfterMillimes, lang)));
    if (s.kind === 'VOID' && s.voidsReceiptNumber) lines.push(line('voids', T.voids, `R-${String(s.voidsReceiptNumber).padStart(6, '0')}`));
    lines.push(line('issuedBy', T.issuedBy, s.issuedBy, false));
    lines.push(line('fingerprint', T.fingerprint, sha256.slice(0, 12)));
    const mark = o.copyNo === 0 ? T.ORIGINAL[lang] : `${T.COPY[lang]} ${o.copyNo}`;
    return { lang, dir: DIR[lang], title: T[s.kind][lang], mark, lines, notice: T.notice[lang] };
  });
  return { documentType: `RECEIPT_${s.kind}`, reference: s.label, size: o.size, fontPt: fontPt(o.size), sections };
}

const esc = (v: string) => v.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Plain printable HTML for a document (sample rendering; the visual design belongs to the frontend). */
export function renderHtml(d: PrintDocument): string {
  const first = d.sections[0]!;
  const body = d.sections.map(s => `<section lang="${s.lang}" dir="${s.dir}">
<h1>${esc(s.title)}${s.mark ? ` <span class="mark">${esc(s.mark)}</span>` : ''}</h1>
<table>${s.lines.map(l => `<tr data-key="${esc(l.key)}"><th scope="row">${esc(l.label)}</th><td>${l.isolate ? `<bdi dir="ltr">${esc(l.value)}</bdi>` : `<bdi>${esc(l.value)}</bdi>`}</td></tr>`).join('')}</table>
<p class="notice">${esc(s.notice)}</p>
</section>`).join('\n<hr>\n');
  return `<!doctype html>
<html lang="${first.lang}" dir="${first.dir}"><head><meta charset="utf-8"><title>${esc(d.reference)}</title>
<style>body{font-family:"Noto Sans","Noto Naskh Arabic",Arial,sans-serif;font-size:${d.fontPt}pt;line-height:1.5;margin:10mm;color:#000;background:#fff}
h1{font-size:1.3em;margin:0 0 4mm}.mark{border:2px solid #000;padding:0 2mm}table{width:100%;border-collapse:collapse}
th,td{text-align:start;padding:1.5mm 0;border-bottom:1px solid #000;vertical-align:top}th{font-weight:normal;width:45%}
.notice{font-size:0.8em;margin-top:4mm}@media print{hr{page-break-after:always;border:0}}</style></head>
<body>
${body}
</body></html>`;
}

export function printOptions(q: { get(k: string): string | null } | Record<string, unknown>) {
  const get = (k: string) => (typeof (q as { get?: unknown }).get === 'function' ? (q as { get(k: string): string | null }).get(k) : (q as Record<string, unknown>)[k]) ?? undefined;
  const lang = (get('lang') ?? 'both') as string;
  const size = (get('size') ?? 'normal') as string;
  const format = (get('format') ?? 'json') as string;
  if (!['fr', 'ar', 'both'].includes(lang)) fail('VALIDATION_FAILED', 'lang must be fr, ar or both', { field: 'lang' });
  if (!['normal', 'large'].includes(size)) fail('VALIDATION_FAILED', 'size must be normal or large', { field: 'size' });
  if (!['json', 'html'].includes(format)) fail('VALIDATION_FAILED', 'format must be json or html', { field: 'format' });
  return { lang, size: size as Size, format };
}


/* ---------- blank paper forms (contracts) ---------- */

export interface FormField { key: string; label: Text; kind: 'text' | 'date' | 'number' | 'choice' | 'signature' | 'preprinted'; required: boolean; hint?: Text; choices?: Array<{ value: string; label: Text }>; apiField?: string }

/** No-phone patient intake. Keys map 1:1 to POST /api/v1/patients. No medical questions (recorded by the dentist). */
export const PATIENT_INTAKE: { title: Text; intro: Text; fields: FormField[]; deskBox: Text } = {
  title: { fr: 'Fiche d\'inscription patient', ar: 'استمارة تسجيل المريض' },
  intro: { fr: 'Aucun téléphone n\'est nécessaire. Les questions médicales sont posées par le dentiste, pas sur cette fiche.', ar: 'لا حاجة إلى هاتف. الأسئلة الطبية يطرحها طبيب الأسنان وليست في هذه الاستمارة.' },
  fields: [
    { key: 'familyName', apiField: 'familyName', kind: 'text', required: true, label: { fr: 'Nom', ar: 'اللقب' } },
    { key: 'givenName', apiField: 'givenName', kind: 'text', required: true, label: { fr: 'Prénom', ar: 'الاسم' } },
    { key: 'nameAr', apiField: 'nameAr', kind: 'text', required: false, label: { fr: 'Nom en arabe', ar: 'الاسم واللقب بالعربية' } },
    { key: 'dateOfBirth', apiField: 'dateOfBirth', kind: 'date', required: false, label: { fr: 'Date de naissance (JJ/MM/AAAA)', ar: 'تاريخ الولادة (يوم/شهر/سنة)' } },
    { key: 'sex', apiField: 'sex', kind: 'choice', required: false, label: { fr: 'Sexe', ar: 'الجنس' },
      choices: [{ value: 'F', label: { fr: 'Femme', ar: 'أنثى' } }, { value: 'M', label: { fr: 'Homme', ar: 'ذكر' } }, { value: 'X', label: { fr: 'Non précisé', ar: 'غير محدد' } }] },
    { key: 'phone', apiField: 'phone', kind: 'text', required: false, label: { fr: 'Téléphone (facultatif)', ar: 'الهاتف (اختياري)' },
      hint: { fr: 'Laisser vide s\'il n\'y a pas de téléphone.', ar: 'اتركه فارغًا إن لم يكن هناك هاتف.' } },
    { key: 'contactPreference', apiField: 'contactPreference', kind: 'choice', required: true, label: { fr: 'Comment vous joindre', ar: 'طريقة التواصل' },
      choices: [{ value: 'IN_PERSON', label: { fr: 'En personne au cabinet', ar: 'حضوريًا بالعيادة' } }, { value: 'BASIC_PHONE_CALL', label: { fr: 'Appel téléphonique', ar: 'مكالمة هاتفية' } },
        { value: 'SMS', label: { fr: 'SMS', ar: 'رسالة قصيرة' } }, { value: 'NONE', label: { fr: 'Aucun', ar: 'لا شيء' } }] },
    { key: 'preferredLanguage', apiField: 'preferredLanguage', kind: 'choice', required: true, label: { fr: 'Langue préférée', ar: 'اللغة المفضلة' },
      choices: [{ value: 'fr', label: { fr: 'Français', ar: 'الفرنسية' } }, { value: 'ar', label: { fr: 'Arabe', ar: 'العربية' } }] },
  ],
  deskBox: { fr: 'Réservé au cabinet — N° de dossier attribué, saisi par, le', ar: 'خاص بالعيادة — رقم الملف المسند، أدخله، بتاريخ' },
};

/** Numbered outage slip (patient copy + clinic stub). Keys map to POST /paper-books/:id/entries. */
export const OUTAGE_SLIP: { title: Text; parts: Text[]; fields: FormField[]; reentry: Text } = {
  title: { fr: 'Reçu provisoire (panne)', ar: 'وصل مؤقت (عطل)' },
  parts: [{ fr: 'Copie patient', ar: 'نسخة المريض' }, { fr: 'Souche cabinet', ar: 'أرومة العيادة' }],
  fields: [
    { key: 'slipNo', apiField: 'slipNo', kind: 'preprinted', required: true, label: { fr: 'N° de reçu provisoire', ar: 'رقم الوصل المؤقت' } },
    { key: 'writtenOn', apiField: 'writtenOn', kind: 'date', required: true, label: { fr: 'Date', ar: 'التاريخ' } },
    { key: 'patientFileNo', apiField: 'patientFileNo', kind: 'number', required: true, label: { fr: 'N° de dossier du patient', ar: 'رقم ملف المريض' },
      hint: { fr: 'Recopier depuis la carte ou le dossier du patient.', ar: 'يُنقل من بطاقة المريض أو ملفه.' } },
    { key: 'patientName', kind: 'text', required: true, label: { fr: 'Nom et prénom du patient', ar: 'اسم المريض ولقبه' } },
    { key: 'amount', apiField: 'amountMillimes', kind: 'number', required: true, label: { fr: 'Montant (DT, millimes)', ar: 'المبلغ (د.ت، مليم)' } },
    { key: 'tender', apiField: 'tender', kind: 'choice', required: true, label: T.tender, choices: [{ value: 'CASH', label: T.CASH }, { value: 'CARD', label: T.CARD }] },
    { key: 'receivedBy', kind: 'signature', required: true, label: { fr: 'Reçu par (signature)', ar: 'استلمه (الإمضاء)' } },
  ],
  reentry: { fr: 'Après le retour du système : saisir N°, date, n° de dossier, montant et mode ; un reçu annulé est saisi « annulé » avec un motif.', ar: 'بعد عودة النظام: يُدخل الرقم والتاريخ ورقم الملف والمبلغ وطريقة الدفع؛ الوصل الملغى يُدخل «ملغى» مع ذكر السبب.' },
};

function formDocument(form: { title: Text; fields: FormField[] }, extra: (lang: Lang) => DocLine[], o: { lang: string; size: Size }, type: string, reference: string): PrintDocument {
  return {
    documentType: type, reference, size: o.size, fontPt: fontPt(o.size),
    sections: langsOf(o.lang).map(lang => ({
      lang, dir: DIR[lang], title: form.title[lang], mark: null, notice: T.notice[lang],
      lines: [...extra(lang), ...form.fields.map(f => ({ key: f.key, label: f.label[lang] + (f.choices ? ` : ${f.choices.map(c => '☐ ' + c.label[lang]).join('   ')}` : ''), value: f.kind === 'preprinted' ? reference : '', isolate: true }))],
    })),
  };
}

export const printRoutes: Route[] = [
  {
    // First print = ORIGINAL, later prints = COPY n. Never a new receipt number. Every print is logged.
    method: 'POST', path: '/api/v1/receipts/:id/print', permission: 'receipt.reprint', idempotent: true,
    handler: async ({ tx, actor, params, body }) => {
      const o = printOptions((body ?? {}) as Record<string, unknown>);
      if (!isUuid(params.id!)) fail('NOT_FOUND', 'Receipt not found');
      const r = await tx.maybeOne<{ id: string; number: number; snapshot: ReceiptSnapshot; sha: string }>('SELECT id, number, snapshot, snapshot_sha256 AS sha FROM receipts WHERE id = $1', [params.id!]);
      if (!r) fail('NOT_FOUND', 'Receipt not found');
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('receipt_print:' || $1))", [r!.id]);
      const prior = await tx.one<{ n: number }>('SELECT count(*)::int AS n FROM receipt_prints WHERE receipt_id = $1', [r!.id]);
      const copyNo = prior.n;
      await tx.query('INSERT INTO receipt_prints (clinic_id, receipt_id, printed_by, is_copy) VALUES ($1,$2,$3,$4)', [actor!.clinicId, r!.id, actor!.staffId, copyNo > 0]);
      await appendAudit(tx, actor!, 'receipt.printed', 'receipt', r!.id, { number: r!.number, copyNo, lang: o.lang, size: o.size });
      const doc = receiptDocument(r!.snapshot, r!.sha, { lang: o.lang, size: o.size, copyNo, timeZone: await clinicTimezone(tx, actor!.clinicId) });
      return { status: 200, body: { copy: copyNo > 0, copyNo, document: doc, ...(o.format === 'html' ? { html: renderHtml(doc) } : {}) } };
    },
  },
  {
    method: 'GET', path: '/api/v1/print/forms/patient-intake', permission: 'patient.create',
    handler: async ({ query }) => {
      const o = printOptions(query);
      const doc = formDocument(PATIENT_INTAKE, lang => [{ key: 'intro', label: PATIENT_INTAKE.intro[lang], value: '', isolate: false }], o, 'FORM_PATIENT_INTAKE', 'INTAKE');
      doc.sections.forEach(s => s.lines.push({ key: 'deskBox', label: PATIENT_INTAKE.deskBox[s.lang], value: '', isolate: true }));
      return { status: 200, body: { form: PATIENT_INTAKE, document: doc, ...(o.format === 'html' ? { html: renderHtml(doc) } : {}) } };
    },
  },
  {
    // Numbered slips of an issued paper book (owner). Every print is logged; a second print is marked as a reprint.
    method: 'POST', path: '/api/v1/paper-books/:id/print', permission: 'paper.issue_book', idempotent: true,
    handler: async ({ tx, actor, params, body }) => {
      const o = printOptions((body ?? {}) as Record<string, unknown>);
      if (!isUuid(params.id!)) fail('NOT_FOUND', 'Paper book not found');
      const b = await tx.maybeOne<{ id: string; prefix: string; first_no: number; last_no: number }>('SELECT id, prefix, first_no, last_no FROM paper_books WHERE id = $1', [params.id!]);
      if (!b) fail('NOT_FOUND', 'Paper book not found');
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('paper_book_print:' || $1))", [b!.id]);
      const prior = await tx.one<{ n: number }>("SELECT count(*)::int AS n FROM audit_events WHERE action = 'paper.book_printed' AND entity_id = $1", [b!.id]);
      const printNo = prior.n + 1;
      await appendAudit(tx, actor!, 'paper.book_printed', 'paper_book', b!.id, { printNo, firstNo: b!.first_no, lastNo: b!.last_no, lang: o.lang, size: o.size });
      const reprint: Text = { fr: `RÉIMPRESSION n° ${printNo} — détruire les exemplaires précédents non utilisés`, ar: `إعادة طبع رقم ${printNo} — تُتلف النسخ السابقة غير المستعملة` };
      const slips = [];
      for (let n = b!.first_no; n <= b!.last_no; n++) {
        const label = `${b!.prefix}-${String(n).padStart(3, '0')}`;
        const doc = formDocument(OUTAGE_SLIP, lang => [
          { key: 'parts', label: OUTAGE_SLIP.parts.map(p => p[lang]).join(' / '), value: '', isolate: false },
          ...(printNo > 1 ? [{ key: 'reprint', label: reprint[lang], value: '', isolate: false, emphasis: true }] : []),
        ], o, 'FORM_OUTAGE_SLIP', label);
        doc.sections.forEach(s => s.lines.push({ key: 'reentry', label: OUTAGE_SLIP.reentry[s.lang], value: '', isolate: false }));
        slips.push(doc);
      }
      return { status: 200, body: { book: { id: b!.id, range: `${slips[0]!.reference}..${slips[slips.length - 1]!.reference}` }, printNo, form: OUTAGE_SLIP, slips,
        ...(o.format === 'html' ? { html: slips.map(renderHtml) } : {}) } };
    },
  },
];
