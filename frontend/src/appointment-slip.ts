import { ApiError } from "./api.ts";
import type { Board, Visit } from "./api.ts";

/** A card must reflect a fresh server-confirmed appointment for the intended patient. */
export function printableAppointment(board: Board, visitId: string, patientId: string): Visit {
  const visit = board.visits.find(item => item.id === visitId);
  if (!visit || visit.status !== "SCHEDULED" || visit.patient.id !== patientId)
    throw new ApiError("CONFLICT", 409);
  return visit;
}

/** Prevent a card prepared earlier from printing after a schedule or timezone change. */
export function assertPrintableUnchanged(
  board: Board,
  prepared: { visit: Visit; day: string; timezone: string },
): void {
  const current = printableAppointment(board, prepared.visit.id, prepared.visit.patient.id);
  if (
    board.day !== prepared.day || board.timezone !== prepared.timezone ||
    current.scheduledAt !== prepared.visit.scheduledAt ||
    current.localTime !== prepared.visit.localTime
  ) throw new ApiError("CONFLICT", 409);
}
