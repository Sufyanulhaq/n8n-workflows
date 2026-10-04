// Runs every workflow headless with n8n's own command line, against the mock services, and checks
// what the mock systems received. No n8n account is needed. Run: npm test
const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const N8N = process.env.N8N_BIN || path.join(ROOT, "node_modules", ".bin", "n8n");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "n8n-workflows-test-"));
const VARIANTS = path.join(HOME, "variants");
fs.mkdirSync(VARIANTS);
const env = { ...process.env, N8N_USER_FOLDER: HOME, N8N_DIAGNOSTICS_ENABLED: "false", N8N_VERSION_NOTIFICATIONS_ENABLED: "false", N8N_PERSONALIZATION_ENABLED: "false" };

const load = (file) => JSON.parse(fs.readFileSync(path.join(ROOT, "workflows", file), "utf8"));
const nodeByName = (wf, name) => wf.nodes.find((n) => n.name === name);
const setField = (wf, nodeName, field, value) => {
  const a = nodeByName(wf, nodeName).parameters.assignments.assignments.find((x) => x.name === field);
  a.value = value;
};
const patchBody = (wf, patch) => {
  const a = nodeByName(wf, "Sample order (test only)").parameters.assignments.assignments.find((x) => x.name === "rawBody");
  a.value = JSON.stringify(patch(JSON.parse(a.value)));
};

// The mock runs as its own process. If it ran inside this one, the blocking n8n calls below would
// stop it from answering n8n's requests and every run would hang.
const MOCK = "http://localhost:8140";
const mockReset = (opts) => fetch(`${MOCK}/__reset`, { method: "POST", body: JSON.stringify(opts || {}) });
const mockState = async () => (await fetch(`${MOCK}/__received`)).json();

const fromRun = (out, node) => {
  const d = JSON.parse(out.slice(out.indexOf("{")));
  return d.data.resultData.runData[node][0].data.main[0][0].json;
};

const LEAD = "1-lead-intake-and-scoring.json", ORDER = "2-signed-order-fan-out.json", ORDER_FILE = ORDER, LEAD_FILE = LEAD, DIGEST = "3-daily-sales-digest.json";
const ALL = [
  { name: "lead: a strong lead goes to the CRM and the sales team", file: LEAD,
    check: (m) => { eq(m.calls, { crm: 1, accounting: 0, slack: 1, sheets: 0 }); eq(m.received.crm[0].headers["idempotency-key"], "lead:dana@northwindclinics.example"); eq(m.received.crm[0].body.label, "Hot"); ok(/Hot lead \d+\/100: Dana Reyes/.test(m.received.slack[0].body.text)); } },
  { name: "lead: a vague lead goes to the nurture list only", file: LEAD,
    patch: (w) => { for (const [k, v] of [["name", ""], ["company", ""], ["email", ""], ["need", "just looking around"], ["budget_amount", 300], ["timeline_months", 12]]) setField(w, "Sample lead (test only)", k, v); },
    check: (m) => { eq(m.calls, { crm: 0, accounting: 0, slack: 0, sheets: 1 }); eq(m.received.sheets[0].body.row[4], "Cold"); } },
  { name: "lead: a strong lead with no email is held at Cold", file: LEAD,
    patch: (w) => setField(w, "Sample lead (test only)", "email", ""),
    check: (m) => { eq(m.calls, { crm: 0, accounting: 0, slack: 0, sheets: 1 }); eq(m.received.sheets[0].body.row[4], "Cold"); } },
  { name: "order: a valid signed order reaches CRM, accounting and Slack once", file: ORDER,
    check: (m, out) => { eq(m.calls, { crm: 1, accounting: 1, slack: 1, sheets: 0 }); eq(fromRun(out, "Summarise delivery").body, { accepted: true, order: "ORD-7001", failed: [] }); eq(m.received.crm[0].headers["idempotency-key"], "ORD-7001:crm"); eq(m.received.accounting[0].body.reference, "ORD-7001"); ok(/New order ORD-7001: 362 GBP/.test(m.received.slack[0].body.text)); } },
  { name: "order: a flaky CRM is retried until it answers, with no duplicate", file: ORDER, mock: { failFirst: { crm: 2 } },
    check: (m) => { eq(m.calls.crm, 3); eq(m.received.crm.length, 1); eq(m.calls.accounting, 1); eq(m.calls.slack, 1); } },
  { name: "order: a refusing accounting system is retried, the rest still goes through", file: ORDER, patch: (w) => patchBody(w, (o) => ({ ...o, currency: "XYZ" })),
    check: (m, out) => { eq(m.calls.accounting, 3); eq(m.received.accounting.length, 0); eq(m.calls.crm, 1); eq(m.calls.slack, 1); eq(fromRun(out, "Summarise delivery").body.failed, ["Send to accounting"]); } },
  { name: "order: a wrong signature sends nothing anywhere", file: ORDER, patch: (w) => { nodeByName(w, "Sign (test only)").parameters.secret = "not-the-secret"; },
    check: (m) => eq(m.calls, { crm: 0, accounting: 0, slack: 0, sheets: 0 }) },
  { name: "order: a stale timestamp sends nothing anywhere", file: ORDER, patch: (w) => setField(w, "Sample order (test only)", "timestamp", "1000000000"),
    check: (m) => eq(m.calls, { crm: 0, accounting: 0, slack: 0, sheets: 0 }) },
  { name: "order: a total that does not add up sends nothing anywhere", file: ORDER, patch: (w) => patchBody(w, (o) => ({ ...o, total: 999 })),
    check: (m) => eq(m.calls, { crm: 0, accounting: 0, slack: 0, sheets: 0 }) },
  { name: "digest: cancelled orders are left out of the numbers", file: DIGEST,
    check: (m) => { eq(m.calls.slack, 1); const t = m.received.slack[0].body.text; ok(t.includes("3 orders") && t.includes("557.50 revenue") && t.includes("Standing desk 430.00"), t); ok(!t.includes("Office chair"), t); } },
  { name: "digest: a quiet day says so", file: DIGEST, mock: { sales: [] },
    check: (m) => eq(m.received.slack[0].body.text, "No orders yesterday.") },
];

const only = process.env.ONLY;
const cases = only ? ALL.filter((c) => c.name.includes(only)) : ALL;

function eq(a, b) { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`expected ${y}, got ${x}`); }
function ok(c, msg = "condition failed") { if (!c) throw new Error(msg); }
const cli = (args, timeout = 150000) => spawnSync(N8N, args, { env, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024 });


// ---- Part 2: the real webhook URLs ------------------------------------------------------------------
// The headless runs above start from the test entry. These start n8n for real, publish the workflows
// and call their webhook URLs over HTTP, which is the path a shop or a website would use.
const LIVE_PORT = 5679;
const SECRET = "demo-secret-change-me";
const SAMPLE_ORDER = { id: "ORD-9001", customer: { name: "Priya Nair", email: "priya.nair@example.com" }, items: [{ sku: "DESK-120", name: "Standing desk", qty: 1, unit_price: 349 }, { sku: "CBL-02", name: "Cable kit", qty: 2, unit_price: 6.5 }], currency: "GBP", total: 362 };
const LEAD_BODY = { name: "Dana Reyes", company: "Northwind Clinics", email: "dana@northwindclinics.example", need: "We want a chatbot connected to our CRM and email", budget_amount: 8000, timeline_months: 0.5 };
const sign = (body, ts, secret = SECRET) => "sha256=" + crypto.createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
async function hit(route, body, opts = {}) {
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  const headers = opts.unsigned ? { "content-type": "application/json" } : { "content-type": "application/json", "x-timestamp": String(ts), "x-signature": sign(body, ts, opts.secret) };
  const res = await fetch(`http://localhost:${LIVE_PORT}/webhook/${route}`, { method: "POST", body, headers });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const liveCases = [
  { name: "live order: a signed order is accepted and delivered once", run: () => hit("orders", JSON.stringify(SAMPLE_ORDER)),
    check: (r, m) => { eq([r.status, r.json], [202, { accepted: true, order: "ORD-9001", failed: [] }]); eq(m.calls, { crm: 1, accounting: 1, slack: 1, sheets: 0 }); } },
  { name: "live order: the signature covers the exact bytes, so a pretty printed body works", run: () => hit("orders", JSON.stringify(SAMPLE_ORDER, null, 2)),
    check: (r) => eq(r.status, 202) },
  { name: "live order: the same order sent twice is stored once", run: async () => { await hit("orders", JSON.stringify(SAMPLE_ORDER)); return hit("orders", JSON.stringify(SAMPLE_ORDER)); },
    check: (r, m) => { eq(r.status, 202); eq([m.received.crm.length, m.received.accounting.length], [1, 1]); } },
  { name: "live order: a flaky CRM is retried and the caller still gets 202", mock: { failFirst: { crm: 2 } }, run: () => hit("orders", JSON.stringify(SAMPLE_ORDER)),
    check: (r, m) => { eq([r.status, r.json.failed], [202, []]); eq([m.calls.crm, m.received.crm.length], [3, 1]); } },
  { name: "live order: a forged signature gets 401 and sends nothing", run: () => hit("orders", JSON.stringify(SAMPLE_ORDER), { secret: "wrong" }),
    check: (r, m) => { eq([r.status, r.json], [401, { error: "signature does not match" }]); eq(m.calls, { crm: 0, accounting: 0, slack: 0, sheets: 0 }); } },
  { name: "live order: a stale signed request gets 401", run: () => hit("orders", JSON.stringify(SAMPLE_ORDER), { ts: 1000000000 }),
    check: (r, m) => { eq(r.status, 401); ok(/too old/.test(r.json.error)); eq(m.calls.crm, 0); } },
  { name: "live order: a request with no signature headers gets 401", run: () => hit("orders", JSON.stringify(SAMPLE_ORDER), { unsigned: true }),
    check: (r, m) => { eq([r.status, r.json.error], [401, "missing timestamp or signature"]); eq(m.calls.crm, 0); } },
  { name: "live order: a signed order whose total is wrong gets 422 with the real figure", run: () => hit("orders", JSON.stringify({ ...SAMPLE_ORDER, total: 999 })),
    check: (r, m) => { eq(r.status, 422); ok(/add up to 362/.test(r.json.error), r.json.error); eq(m.calls.crm, 0); } },
  { name: "live lead: a strong lead is scored Hot and replied to", run: () => hit("lead-intake", JSON.stringify(LEAD_BODY)),
    check: (r, m) => { eq([r.status, r.json.label, r.json.score], [200, "Hot", 100]); eq([m.calls.crm, m.calls.slack, m.calls.sheets], [1, 1, 0]); } },
  { name: "live lead: a vague lead is scored Cold and goes to the nurture list", run: () => hit("lead-intake", JSON.stringify({ need: "just looking", budget_amount: 100, timeline_months: 12 })),
    check: (r, m) => { eq([r.status, r.json.label], [200, "Cold"]); eq([m.calls.crm, m.calls.sheets], [0, 1]); } },
];

async function runLive() {
  const home = path.join(HOME, "live");
  fs.mkdirSync(path.join(home, "wf"), { recursive: true });
  const liveEnv = { ...env, N8N_USER_FOLDER: home, N8N_PORT: String(LIVE_PORT) };
  for (const [file, id] of [[ORDER_FILE, "live_ord"], [LEAD_FILE, "live_lead"]]) {
    const w = load(file); w.id = id; fs.writeFileSync(path.join(home, "wf", `${id}.json`), JSON.stringify(w));
  }
  const run = (args) => spawnSync(N8N, args, { env: liveEnv, encoding: "utf8", timeout: 150000 });
  if (run(["import:workflow", "--separate", `--input=${path.join(home, "wf")}`]).status !== 0) throw new Error("import failed");
  for (const id of ["live_ord", "live_lead"]) if (run(["publish:workflow", `--id=${id}`]).status !== 0) throw new Error("publish failed for " + id);
  const server = spawn(N8N, ["start"], { env: liveEnv, stdio: "ignore" });
  try {
    let up = false;
    for (let i = 0; i < 90 && !up; i++) { try { up = (await fetch(`http://localhost:${LIVE_PORT}/healthz`)).ok; } catch { await new Promise((r) => setTimeout(r, 1000)); } }
    if (!up) throw new Error("n8n did not start");
    await new Promise((r) => setTimeout(r, 1500)); // let the webhooks register
    let failures = 0;
    const selected = only ? liveCases.filter((c) => c.name.includes(only)) : liveCases;
    for (const c of selected) {
      await mockReset(c.mock);
      let result = "PASS", note = "";
      try { c.check(await c.run(), await mockState()); } catch (e) { result = "FAIL"; note = e.message; failures++; }
      console.log(`${result}  ${c.name}${note ? "\n      " + note : ""}`);
    }
    return failures;
  } finally { server.kill(); }
}

(async () => {
  if (!fs.existsSync(N8N)) { console.error(`n8n not found at ${N8N}. Run npm install first, or set N8N_BIN.`); process.exit(2); }
  const mockProcess = spawn(process.execPath, [path.join(ROOT, "mock", "server.js")], { stdio: "ignore" });
  for (let i = 0; ; i++) {
    try { await mockState(); break; } catch { if (i > 50) { console.error("the mock services did not start (is port 8140 already in use?)"); mockProcess.kill(); process.exit(2); } await new Promise((r) => setTimeout(r, 100)); }
  }
  cases.forEach((c, i) => { const w = load(c.file); w.id = `t${i}`; if (c.patch) c.patch(w); fs.writeFileSync(path.join(VARIANTS, `t${i}.json`), JSON.stringify(w)); });
  const imp = cli(["import:workflow", "--separate", `--input=${VARIANTS}`]);
  if (imp.status !== 0) { console.error(imp.stdout, imp.stderr); mockProcess.kill(); process.exit(2); }
  let failed = 0;
  for (const [i, c] of cases.entries()) {
    await mockReset(c.mock);
    const run = cli(["execute", `--id=t${i}`, "--rawOutput"]);
    let result = "PASS", note = "";
    try {
      ok(run.status === 0, "n8n exited with status " + run.status + " " + (run.stderr || "").slice(0, 300));
      c.check(await mockState(), run.stdout);
    } catch (e) { result = "FAIL"; note = e.message; failed++; if (process.env.DEBUG) console.log("stdout length", run.stdout.length, "\n", run.stdout.slice(-2500), "\nSTDERR:", (run.stderr || "").slice(-1500)); }
    console.log(`${result}  ${c.name}${note ? "\n      " + note : ""}`);
  }
  console.log("");
  let liveFailed = 0;
  try { liveFailed = await runLive(); } catch (e) { console.log("FAIL  live webhook tests could not run: " + e.message); liveFailed = 1; }
  mockProcess.kill();
  const total = cases.length + (only ? liveCases.filter((c) => c.name.includes(only)).length : liveCases.length);
  const bad = failed + liveFailed;
  console.log(bad ? `\n${bad} failed (of ${total})` : `\nall ${total} passed`);
  process.exit(bad ? 1 : 0);
})();
