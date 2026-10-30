import assert from "node:assert/strict";
import test from "node:test";
import { cashIndependenceNotes } from "../src/cash-evidence.ts";
import { clinicPaymentTime } from "../src/time.ts";

const software = "software check only: physical independence of the count cannot be proven by software";
const receptionist = "counter also holds the RECEPTIONIST role";
const payments = "counter recorded 2 cash payment(s) in this period";

test("cash-count evidence translates each server-authored phrase without losing its warning", () => {
  const fr = cashIndependenceNotes([receptionist, payments, software].join("; "), "fr");
  const ar = cashIndependenceNotes([receptionist, payments, software].join("; "), "ar");
  assert.match(fr, /réceptionniste/);
  assert.match(fr, /2 paiement/);
  assert.match(fr, /ne peut pas être prouvée/);
  assert.match(ar, /موظف الاستقبال/);
  assert.match(ar, /2 عملية/);
  assert.match(ar, /لا يمكن للبرنامج إثبات/);
});

test("unrecognized audit notes are never silently dropped or reinterpreted", () => {
  assert.equal(cashIndependenceNotes("new evidence rule; " + software, "fr"),
    "new evidence rule; Contrôle logiciel uniquement : l'indépendance du comptage physique ne peut pas être prouvée par le logiciel");
  assert.equal(cashIndependenceNotes("unknown audit rule; " + software, "ar"),
    "unknown audit rule; فحص برمجي فقط: لا يمكن للبرنامج إثبات استقلالية الجرد الفعلي");
});

test("cash-count audit timestamp is explicitly UTC and independent of device timezone", () => {
  const recorded = "2026-01-15T12:34:00Z";
  for (const lang of ["fr", "ar"] as const) {
    const shown = clinicPaymentTime(recorded, lang, "UTC") + " UTC";
    assert.match(shown, /12:34/);
    assert.match(shown, /UTC$/);
    assert.doesNotMatch(shown, /[٠-٩]/);
  }
});
