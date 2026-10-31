const parts = (at: number, zone: string) =>
  Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(at))
      .map((p) => [p.type, p.value]),
  );
const wall = (at: number, zone: string) => {
  const p = parts(at, zone);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
};
/** Resolve in the clinic zone, never the device zone. Refuse nonexistent OR repeated wall times. */
export function clinicInstant(day: string, time: string, zone: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}$/.test(time))
    throw new Error("INVALID_TIME");
  const target = `${day}T${time}`,
    naive = Date.parse(target + ":00Z");
  if (
    !Number.isFinite(naive) ||
    new Date(naive).toISOString().slice(0, 16) !== target
  )
    throw new Error("INVALID_TIME");
  const candidates = new Set<number>();
  for (const delta of [-86400000, 0, 86400000]) {
    const sample = naive + delta,
      p = parts(sample, zone);
    const offset =
      Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`) -
      sample;
    const candidate = naive - offset;
    if (wall(candidate, zone) === target) candidates.add(candidate);
  }
  if (candidates.size !== 1) throw new Error("AMBIGUOUS_TIME");
  return new Date([...candidates][0]!).toISOString();
}
export function shiftDay(day: string, step: number) {
  const date = new Date(day + "T12:00:00Z");
  date.setUTCDate(date.getUTCDate() + step);
  return date.toISOString().slice(0, 10);
}
export function dateLabel(day: string, locale: string) {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-TN" : "fr-TN", {
    dateStyle: "full",
    timeZone: "UTC",
  }).format(new Date(day + "T12:00:00Z"));
}

/** Render ledger timestamps in the same server-provided clinic zone as the dayboard. */
export function clinicPaymentTime(value: string, lang: "fr" | "ar", timezone: string): string {
  const when = new Date(value);
  if (!Number.isFinite(when.getTime())) return "—";
  return new Intl.DateTimeFormat(lang === "ar" ? "ar-TN-u-nu-latn" : "fr-TN", {
    timeZone: timezone, day: "2-digit", month: "2-digit",
    year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(when);
}
