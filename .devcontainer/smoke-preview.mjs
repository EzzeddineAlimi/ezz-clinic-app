// Codespaces fixture smoke test: only simulated Host/Origin inside the isolated CI Compose network.
// This is not a real GitHub port-authentication test and must never accept real patient data.
import http from "node:http";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

const host = "ezz-preview-ci-5173.app.github.dev";
const origin = "https://" + host;
function request(path, options = {}) {
  const { method = "GET", body, hostHeader = host, token, originHeader = origin } = options;
  const textBody = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port: 5173,
      method,
      path,
      timeout: 3000,
      headers: {
        Host: hostHeader,
        Origin: originHeader,
        ...(textBody !== undefined ? {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(textBody)
        } : {}),
        ...(token ? { Authorization: "Bearer " + token } : {})
      }
    }, res => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", x => { text += x; });
      res.on("end", () => resolve({ status: res.statusCode, text, headers: res.headers }));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Request timeout")));
    req.end(textBody);
  });
}

let ready = false;
for (let i = 0; i < 90; i++) {
  try {
    const res = await request("/", { originHeader: undefined });
    if (res.status === 200 && res.text.includes("<html")) {
      ready = true;
      break;
    }
  } catch { /* preview startup in progress */ }
  await sleep(1000);
}
assert.ok(ready, "Private preview did not start on 5173");
const login = await request("/api/v1/session/login", {
  method: "POST",
  body: { clinicCode: "web-fictional", username: "desk", password: "fictional-pass-123" }
});
assert.equal(login.status, 200, "Real API login must succeed through the exact HTTPS preview Origin");
const data = JSON.parse(login.text);
assert.ok(data.token && data.staff?.roles?.includes("RECEPTIONIST"));
const board = await request("/api/v1/day-board", { token: data.token });
assert.equal(board.status, 200);
const result = JSON.parse(board.text);
assert.ok(Array.isArray(result.visits) && result.visits.length >= 5);
const denied = await request("/", { hostHeader: "attacker.example" });
assert.notEqual(denied.status, 200, "Unapproved host must be rejected");
console.log("PASS: built UI, strict host, real fictional API login and seeded day board.");
