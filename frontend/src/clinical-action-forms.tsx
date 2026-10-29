import type { FormEvent } from "react";
import type { Lang } from "./i18n.ts";
import { clinicalText } from "./clinical-text.ts";

export function FindingForm({ lang, disabled, submit }: {
  lang: Lang; disabled: boolean; submit: (e: FormEvent<HTMLFormElement>) => void;
}) {
  const t = clinicalText[lang];
  const label = lang === "fr" ? {
    kind: "Type", existing: "État existant", finding: "Constatation",
    condition: "Code de condition", note: "Observation facultative",
  } : {
    kind: "النوع", existing: "حالة موجودة", finding: "ملاحظة",
    condition: "رمز الحالة", note: "تفاصيل اختيارية",
  };
  return (
    <form className="cash-form" onSubmit={submit}>
      <fieldset disabled={disabled}>
        <label>{label.kind}
          <select name="kind" defaultValue="FINDING" required>
            <option value="FINDING">{label.finding}</option>
            <option value="EXISTING">{label.existing}</option>
          </select>
        </label>
        <label>{t.tooth} *
          <input name="toothFdi" type="number" required min={11} max={85} step={1} />
        </label>
        <label>{label.condition} *
          <input name="conditionCode" required minLength={2} maxLength={41}
            pattern="[A-Za-z][A-Za-z0-9_]{1,40}" autoComplete="off" />
        </label>
        <label>{label.note}
          <textarea name="note" maxLength={500} rows={2} />
        </label>
      </fieldset>
      <button className="primary" type="submit" disabled={disabled}>{t.add}</button>
    </form>
  );
}

export function PlanForm({ lang, disabled, submit }: {
  lang: Lang; disabled: boolean; submit: (e: FormEvent<HTMLFormElement>) => void;
}) {
  const t = clinicalText[lang];
  const extra = lang === "fr" ? { phase:"Phase du traitement (1–4)", note:"Note du plan (facultative)" } :
    { phase:"مرحلة العلاج (1–4)", note:"ملاحظة اختيارية" };
  return (
    <form className="cash-form" onSubmit={submit}>
      <fieldset disabled={disabled}>
        <label>{t.code} *
          <input name="procedureCode" required minLength={2} maxLength={32}
            pattern="[A-Za-z0-9_.-]{2,32}" autoComplete="off" />
        </label>
        <label>{t.description} *
          <input name="procedureLabel" required minLength={2} maxLength={160} />
        </label>
        <label>{t.tooth}
          <input name="toothFdi" type="number" min={11} max={85} step={1} />
        </label>
        <label>{extra.phase}
          <select name="phaseNo" defaultValue="2" required>
            {[1,2,3,4].map(value => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label>{t.estimate}
          <input name="estimatedFee" dir="ltr" inputMode="decimal" placeholder="150.000"
            pattern="(0|[1-9][0-9]{0,5})([.,][0-9]{1,3})?" />
        </label>
        <label>{extra.note}
          <textarea name="note" maxLength={500} rows={2} />
        </label>
      </fieldset>
      <button className="primary" type="submit" disabled={disabled}>{t.add}</button>
    </form>
  );
}

export function PlanStatusForm({ lang, disabled, status, submit }: {
  lang: Lang; disabled: boolean; status: "PROPOSED" | "ACCEPTED";
  submit: (e: FormEvent<HTMLFormElement>) => void;
}) {
  const tr = lang === "fr" ? {
    status:"Décision", accept:"Accepter", decline:"Refuser", cancel:"Annuler",
    reason:"Motif (obligatoire pour refus ou annulation)", save:"Enregistrer la décision",
  } : {
    status:"القرار", accept:"قبول", decline:"رفض", cancel:"إلغاء",
    reason:"السبب (إجباري عند الرفض أو الإلغاء)", save:"تسجيل القرار",
  };
  return (
    <form className="clinical-status" onSubmit={submit}>
      <fieldset disabled={disabled}>
        <label>{tr.status}
          <select name="status" defaultValue={status === "PROPOSED" ? "ACCEPTED" : "CANCELLED"}>
            {status === "PROPOSED" && <option value="ACCEPTED">{tr.accept}</option>}
            {status === "PROPOSED" && <option value="DECLINED">{tr.decline}</option>}
            <option value="CANCELLED">{tr.cancel}</option>
          </select>
        </label>
        <label>{tr.reason}
          <input name="reason" maxLength={300} autoComplete="off" />
        </label>
      </fieldset>
      <button className="secondary" type="submit" disabled={disabled}>{tr.save}</button>
    </form>
  );
}
