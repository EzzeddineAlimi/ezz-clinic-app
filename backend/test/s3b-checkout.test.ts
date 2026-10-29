import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  createTestDb,
  startApi,
  standardFixture,
  confirmCare,
  seedClinic,
  adminConn,
  type Api,
  type TestDb,
} from "./helpers.ts";
let db: TestDb, api: Api;
before(async () => {
  db = await createTestDb();
  api = await startApi(db.appUrl);
});
after(async () => {
  await api.close();
  await db.drop();
});
test("S3B real payment replay, receipt identity, mismatch, duplicate, overpayment and tenant/role denial", async () => {
  const f = await standardFixture(api, db, "s3b");
  await confirmCare(api, f.dentist, f.visitId, 100000);
  const path = `/api/v1/visits/${f.visitId}/payments`,
    idem = crypto.randomUUID(),
    body = { amountMillimes: 30000, tender: "CASH" };
  const first = await api.call("POST", path, { token: f.desk, idem, body });
  assert.equal(first.status, 201);
  assert.equal(first.body.payment.evidence.tier, "DESK_RECORD");
  assert.equal(first.body.payment.evidence.verifiedBy, null);
  const replay = await api.call("POST", path, { token: f.desk, idem, body });
  assert.equal(replay.body.replayed, true);
  assert.deepEqual(replay.body.payment, first.body.payment);
  assert.deepEqual(replay.body.receipt, first.body.receipt);
  assert.equal(
    (
      await api.call("POST", path, {
        token: f.desk,
        idem,
        body: { ...body, amountMillimes: 1 },
      })
    ).status,
    409,
  );
  const dup = await api.call("POST", path, { token: f.desk, body });
  assert.equal(dup.body.error.code, "POSSIBLE_DUPLICATE_PAYMENT");
  assert.equal(
    (
      await api.call("POST", path, {
        token: f.desk,
        body: { amountMillimes: 70001, tender: "CARD" },
      })
    ).body.error.code,
    "AMOUNT_EXCEEDS_BALANCE",
  );
  const receiptPath = `/api/v1/receipts/${first.body.receipt.id}`;
  const r = await api.call("GET", receiptPath, { token: f.desk });
  assert.equal(r.body.receipt.snapshot.label, first.body.receipt.label);
  assert.equal(r.body.receipt.snapshot.balanceAfterMillimes, 70000);
  for (let n = 0; n < 2; n++) {
    const p = await api.call("POST", receiptPath + "/print", {
      token: f.desk,
      body: { lang: "both" },
    });
    assert.equal(p.status, 200);
    assert.equal(p.body.copyNo, n);
    assert.equal(p.body.document.reference, first.body.receipt.label);
  }
  assert.deepEqual(
    (await api.call("GET", receiptPath, { token: f.desk })).body,
    r.body,
  );
  const assistantClinic = await seedClinic(db, "s3b-assistant", [
    { username: "assistant", roles: ["ASSISTANT"] },
  ]);
  void assistantClinic;
  const assistant = await api.login("s3b-assistant", "assistant");
  for (const [method, p] of [
    ["GET", path],
    ["GET", receiptPath],
    ["POST", path],
  ] as const)
    assert.equal(
      (await api.call(method, p, { token: assistant, body })).status,
      403,
    );
  const other = await standardFixture(api, db, "s3b-other");
  for (const [method, p] of [
    ["GET", path],
    ["GET", receiptPath],
    ["POST", path],
  ] as const)
    assert.equal(
      (await api.call(method, p, { token: other.desk, body })).status,
      404,
    );
  const final = await api.call("POST", path, {
    token: f.desk,
    body: { amountMillimes: 70000, tender: "CARD" },
  });
  assert.equal(final.status, 201);
  assert.equal(final.body.balanceAfterMillimes, 0);
  assert.equal(final.body.payment.evidence.tier, "DESK_CLAIM");
  const history = await api.call("GET", path, { token: f.desk });
  assert.equal(history.body.payments.length, 2);
});
test("S3B no open or closed-only cash period fails closed without financial rows", async () => {
  const f = await standardFixture(api, db, "s3b-closed", {
    openCashPeriod: false,
  });
  await confirmCare(api, f.dentist, f.visitId, 100000);
  const path = `/api/v1/visits/${f.visitId}/payments`;
  for (const closed of [false, true]) {
    if (closed) {
      const cp = await api.call("POST", "/api/v1/cash/periods", {
        token: f.owner,
        body: { openingFloatMillimes: 0 },
      });
      const id = cp.body.period.id;
      const count = await api.call(
        "POST",
        `/api/v1/cash/periods/${id}/counts`,
        { token: f.dentist, body: { countedMillimes: 0 } },
      );
      const close = await api.call("POST", `/api/v1/cash/periods/${id}/close`, {
        token: f.owner,
        body: { acceptedCountId: count.body.count.id, handoverMillimes: 0 },
      });
      assert.equal(close.status, 200);
      // Simulate a closed-only recovery snapshot in this disposable database.
      const c = await adminConn(db.name);
      try {
        await c.query(
          "DELETE FROM cash_periods WHERE clinic_id=$1 AND status='OPEN'",
          [f.clinic.id],
        );
      } finally {
        await c.end();
      }
    }
    const r = await api.call("POST", path, {
      token: f.desk,
      body: { amountMillimes: 1, tender: "CASH" },
    });
    assert.equal(r.body.error.code, "NO_OPEN_CASH_PERIOD");
    assert.equal(
      (await api.call("GET", path, { token: f.desk })).body.payments.length,
      0,
    );
  }
});
