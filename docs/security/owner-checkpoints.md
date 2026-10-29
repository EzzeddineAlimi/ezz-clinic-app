# Owner audit checkpoints (R73 package A)

## Why
The audit chain detects edited or removed events by recomputation. A database superuser who rewrites a row *and* recomputes the whole chain leaves it internally consistent (B06 T-INT-LIMIT-1). A checkpoint copied **outside** the database closes that gap, from the checkpoint onward.

Checkpoints are owner-only and add no step for the receptionist.

**Limit (in every response):** a checkpoint proves that the recorded history up to its sequence number was not rewritten, deleted or rolled back afterwards. It cannot show money or care that was never recorded (CH-002).

## Owner routine
1. `POST /api/v1/owner/checkpoints` (`audit.checkpoint`, password re-entry; body: `note`, `lang`, `size`, `format`) returns:
   - `line`: `EZZ-CP2 clinic=<code> seq=<n> hash=<64 hex> at=<ISO> check=<8 hex>`;
   - a printable FR/AR sheet (`document`, `html` if `format=html`). It has the hash in groups of 4, the check code, a signature box, and no patient data.

   Keep the line or sheet **outside** the clinic system (paper at home, a personal photo or email). There is deliberately no reprint from the database: a reprint would copy whatever the database says *now*.
2. `GET /api/v1/owner/checkpoints` (`audit.verify`) returns:
   - `due`: true when there is no checkpoint, or the last one is at least 7 days old (`CHECKPOINT_DUE_DAYS`, also used by owner exceptions);
   - the age of the last checkpoint;
   - `eventsSinceLast`: events after it, excluding checkpoint bookkeeping;
   - the database's **own** copies, each compared with the chain (`MATCHES`, `DIFFERS` or `CHAIN_SHORTER`). These copies are only a tripwire.
3. `POST /api/v1/owner/checkpoints/verify` (`audit.verify`; body `{ lines: [...] }`, 1–50 lines) gives one verdict per line:

| Verdict | Meaning |
|---|---|
| `MATCHES` | History up to that checkpoint is unchanged. |
| `TAMPERED` | History up to the checkpoint differs from what was checkpointed (changed afterwards). |
| `CHAIN_SHORTER` | History now ends before the checkpoint: records removed, or an older backup restored. |
| `WRONG_CLINIC` | The line belongs to another clinic. |
| `CHECKSUM_FAILED` | The line was mistyped. This is **never** reported as tampering. |
| `MALFORMED` | Not a complete line. |

Legacy `EZZ-CHECKPOINT …` lines from `/api/v1/audit/checkpoints` are still accepted (they have no check code). The existing `/audit/checkpoints` and `/audit/verify` routes are unchanged.

## Integration points
- **`/integrity/check`** adds `INTERNAL_CHECKPOINT_MISMATCH` when the database's own checkpoint copies no longer match the chain. This catches a careless rewrite; a careful one also rewrites those copies, which only the outside line detects.
- **Restore (B14):** `restoreAndVerify({ checkpointLines })` and `scripts/restore-verify.ts … checkpoints.txt` (one line per row). Each clinic gets a `CHECKPOINT_LINES:<code>` check. An **older backup restored after a newer checkpoint fails with `CHAIN_SHORTER`**. Unreadable lines fail `CHECKPOINT_LINES_READABLE` instead of being ignored.

## Tests
`backend/test/r73-owner-checkpoints.test.ts`, T-CP-1..8:
- create and permissions;
- the verdicts, including typo and legacy lines;
- a consistent chain rewrite caught only by the outside line;
- the tripwire on a careless rewrite (RED before the fix);
- removed tail records;
- stale status;
- old-backup restore caught;
- line-format coverage.

## Open (owner policy, not engineering)
- How often to checkpoint. The default reminder is 7 days.
- Where the owner keeps the outside copy.
- Whether a second person (an accountant) should also hold copies.
