# EZZ Clinic — fictional-data prototype v0.1

**NOT FOR CLINICAL USE.** This is a local-only research/build demonstration. It has no real authentication, persistent database, protected ledger, backups, payment gateway, medical chart, device connectivity, or legal/compliance approval. Never enter real patient data. Demo identity labels are not authentication.

## Run

Requires Node.js 22 and TypeScript compiler `tsc` installed. No third-party dependencies are used.

```bash
npm run typecheck
npm test
npm start
```

Open `http://127.0.0.1:4173` on the same computer. The service listens on loopback only. Data resets when the server stops.

## Scope

Patient → appointment → doctor-care confirmation (simulated) → partial/full cash/card record → sequential simulated receipt → synthetic cash discrepancy → event history. All money stored in integer millimes; card payments are simulations.

## Release gates

Before any real data: authenticate clinic users; implement role-based permissions on server; design a protected audit store with independent owner-held evidence; use secure durable database + backups; follow local medical data law, payment delegation, Tunisian medical fee-note/invoicing and residency rules; independently test security, dental usability, accessibility and restore; get founder's separate go-live decision. The app can never guarantee zero theft, including completely off-book cash.
