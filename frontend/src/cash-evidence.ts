import type { Lang } from "./i18n.ts";

// Translate only the three server-authored audit phrases. Preserve unfamiliar evidence verbatim.
export function cashIndependenceNotes(raw: string, lang: Lang): string {
  const phrases = raw.split("; ").map(phrase => {
    if (phrase === "counter also holds the RECEPTIONIST role") {
      return lang === "ar"
        ? "الشخص الذي أجرى الجرد لديه أيضًا صلاحية موظف الاستقبال"
        : "La personne ayant compté les espèces possède aussi le rôle de réceptionniste";
    }
    const recorded = /^counter recorded ([0-9]+) cash payment\(s\) in this period$/.exec(phrase);
    if (recorded) {
      return lang === "ar"
        ? `سجّل الشخص الذي أجرى الجرد ${recorded[1]} عملية دفع نقدي خلال هذه الفترة`
        : `La personne ayant compté les espèces a enregistré ${recorded[1]} paiement(s) en espèces pendant cette période`;
    }
    if (phrase === "software check only: physical independence of the count cannot be proven by software") {
      return lang === "ar"
        ? "فحص برمجي فقط: لا يمكن للبرنامج إثبات استقلالية الجرد الفعلي"
        : "Contrôle logiciel uniquement : l'indépendance du comptage physique ne peut pas être prouvée par le logiciel";
    }
    return phrase;
  });
  return phrases.join(lang === "ar" ? "؛ " : "; ");
}
