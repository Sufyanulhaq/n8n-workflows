// Generates the three workflow files so node settings stay consistent. Run: node scripts/build.js
const fs = require("fs");
const path = require("path");

const BASE = "={{ $('Settings').first().json.base_url }}";
let n = 0;
const id = () => `n${++n}`;
const node = (name, type, version, position, parameters, extra = {}) => ({ id: id(), name, type: `n8n-nodes-base.${type}`, typeVersion: version, position, parameters, ...extra });
const set = (name, position, fields, keepOthers = false) =>
  node(name, "set", 3.4, position, {
    assignments: { assignments: fields.map(([k, v, t = "string"]) => ({ id: id(), name: k, value: v, type: t })) },
    includeOtherFields: keepOthers, // without this a Set node drops every field that came in
    options: {},
  });
const code = (name, position, js) => node(name, "code", 2, position, { mode: "runOnceForAllItems", jsCode: js });
const http = (name, position, method, url, body, opts = {}) =>
  node(
    name, "httpRequest", 4.2, position,
    {
      method, url,
      ...(opts.headers ? { sendHeaders: true, headerParameters: { parameters: opts.headers } } : {}),
      ...(body ? { sendBody: true, specifyBody: "json", jsonBody: body } : {}),
      options: opts.options || {},
    },
    {
      ...(opts.retry ? { retryOnFail: true, maxTries: 3, waitBetweenTries: 500, onError: "continueRegularOutput" } : {}),
      ...(opts.always ? { alwaysOutputData: true } : {}), // an empty list from the API still lets the flow carry on
    },
  );
const ifNode = (name, position, left, op, right) =>
  node(name, "if", 2.2, position, {
    conditions: {
      options: { caseSensitive: true, leftValue: "", typeValidation: "loose", version: 2 },
      conditions: [{ id: id(), leftValue: left, rightValue: right, operator: op }],
      combinator: "and",
    },
    options: {},
  });
const connect = (map) => {
  const out = {};
  for (const [from, outputs] of Object.entries(map)) {
    out[from] = { main: outputs.map((targets) => targets.map((t) => ({ node: t, type: "main", index: 0 }))) };
  }
  return out;
};
const workflow = (name, nodes, connections) => ({ name, nodes, connections, active: false, settings: { executionOrder: "v1" }, pinData: {}, meta: { templateCredsSetupCompleted: true } });
const write = (file, wf) => fs.writeFileSync(path.join(__dirname, "..", "workflows", file), JSON.stringify(wf, null, 2) + "\n");

// ---------------------------------------------------------------------------------------------
// 1. Lead intake and scoring
const SCORE = `
// Same visible rules as the Lead Qualification Agent repo. Change the numbers to suit your business.
const src = $input.first().json;
const lead = src.body || src;
const text = String(lead.need || '').toLowerCase();
const SERVICES = {
  chatbot: ['chatbot', 'chat bot', 'assistant', 'support bot', 'customer support'],
  automation: ['automate', 'automation', 'workflow', 'n8n', 'zapier', 'repetitive', 'manual'],
  integration: ['integrat', 'api', 'webhook', 'connect', 'crm', 'sync'],
  'web app': ['web app', 'website', 'dashboard', 'portal', 'saas', 'mvp', 'admin panel', 'platform'],
  documents: ['pdf', 'document', 'invoice', 'contract'],
  email: ['email', 'inbox'],
  data: ['scrap', 'spreadsheet', 'report', 'etl', 'data pipeline'],
};
const services = Object.keys(SERVICES).filter((k) => SERVICES[k].some((w) => text.includes(w))).sort();
const reasons = [];
let fit = services.length >= 2 ? 25 : services.length === 1 ? 18 : 5;
reasons.push(services.length ? 'clear need: ' + services.join(', ') : 'need is vague');
let budget = 8; const amount = lead.budget_amount;
if (amount != null && amount !== '') {
  const a = Number(amount);
  budget = a >= 5000 ? 30 : a >= 2000 ? 24 : a >= 1000 ? 18 : a >= 500 ? 10 : 4;
  reasons.push('budget of ' + a);
} else reasons.push('budget not given');
let timeline = 8; const months = lead.timeline_months;
if (months != null && months !== '') {
  const m = Number(months);
  timeline = m <= 1 ? 25 : m <= 3 ? 15 : 6;
  reasons.push(m <= 1 ? 'wants to start within a month' : m <= 3 ? 'wants to start within three months' : 'timeline is more than three months away');
} else reasons.push('no timeline given');
const contact = (lead.email ? 12 : 0) + (lead.company ? 4 : 0) + (lead.name ? 4 : 0);
const missing = ['email', 'company', 'name'].filter((k) => !lead[k]);
reasons.push(missing.length ? 'missing ' + missing.join(', ') : 'full contact details');
const total = fit + budget + timeline + contact;
let label = total >= 70 ? 'Hot' : total >= 45 ? 'Warm' : 'Cold';
if (!lead.email && label !== 'Cold') { label = 'Cold'; reasons.push('held at Cold because there is no email to follow up on'); }
return [{ json: { ...lead, services, score: total, label, reasons } }];
`;
{
  const settings = set("Settings", [440, 300], [["base_url", "http://localhost:8140"]], true);
  const nodes = [
    node("Lead webhook", "webhook", 2, [0, 160], { httpMethod: "POST", path: "lead-intake", responseMode: "responseNode", options: {} }, { webhookId: "lead-intake-demo" }),
    node("Test run", "manualTrigger", 1, [0, 440], {}),
    set("Sample lead (test only)", [220, 440], [
      ["name", "Dana Reyes"], ["company", "Northwind Clinics"], ["email", "dana@northwindclinics.example"],
      ["need", "We want a chatbot connected to our CRM and email so urgent questions reach staff."],
      ["budget_amount", "8000", "number"], ["timeline_months", "0.5", "number"],
    ]),
    settings,
    code("Score lead", [660, 300], SCORE),
    ifNode("Is it hot?", [880, 300], "={{ $json.label }}", { type: "string", operation: "equals" }, "Hot"),
    http("Create CRM contact", [1120, 180], "POST", `${BASE}/crm/contacts`,
      "={{ JSON.stringify({ name: $json.name, company: $json.company, email: $json.email, score: $json.score, label: $json.label, reasons: $json.reasons }) }}",
      { headers: [{ name: "Idempotency-Key", value: "={{ 'lead:' + $json.email }}" }], retry: true }),
    http("Tell the sales team", [1360, 180], "POST", `${BASE}/slack`,
      "={{ JSON.stringify({ text: 'Hot lead ' + $('Score lead').first().json.score + '/100: ' + $('Score lead').first().json.name + ' at ' + $('Score lead').first().json.company }) }}", { retry: true }),
    http("Add to nurture list", [1120, 420], "POST", `${BASE}/sheets`,
      "={{ JSON.stringify({ row: [$json.name || '', $json.company || '', $json.email || '', $json.score, $json.label] }) }}", { retry: true }),
    node("Reply", "respondToWebhook", 1.1, [1600, 300], {
      respondWith: "json",
      responseBody: "={{ JSON.stringify({ label: $('Score lead').first().json.label, score: $('Score lead').first().json.score, reasons: $('Score lead').first().json.reasons }) }}",
      options: { responseCode: 200 },
    }),
  ];
  write("1-lead-intake-and-scoring.json", workflow("Lead intake and scoring", nodes, connect({
    "Lead webhook": [["Settings"]],
    "Test run": [["Sample lead (test only)"]],
    "Sample lead (test only)": [["Settings"]],
    Settings: [["Score lead"]],
    "Score lead": [["Is it hot?"]],
    "Is it hot?": [["Create CRM contact"], ["Add to nurture list"]],
    "Create CRM contact": [["Tell the sales team"]],
    "Tell the sales team": [["Reply"]],
    "Add to nurture list": [["Reply"]],
  })));
}

// ---------------------------------------------------------------------------------------------
// 2. Signed order webhook, checked, then sent to three systems
const SECRET = "demo-secret-change-me";
{
  const nodes = [
    node("Order webhook", "webhook", 2, [0, 120], { httpMethod: "POST", path: "orders", responseMode: "responseNode", options: { rawBody: true } }, { webhookId: "orders-demo" }),
    node("Test run", "manualTrigger", 1, [0, 440], {}),
    set("Sample order (test only)", [220, 440], [
      ["rawBody", JSON.stringify({ id: "ORD-7001", customer: { name: "Priya Nair", email: "priya.nair@example.com" }, items: [{ sku: "DESK-120", name: "Standing desk", qty: 1, unit_price: 349 }, { sku: "CBL-02", name: "Cable kit", qty: 2, unit_price: 6.5 }], currency: "GBP", total: 362 })],
      ["timestamp", "={{ String(Math.floor(Date.now() / 1000)) }}"],
    ]),
    node("Sign (test only)", "crypto", 1, [440, 440], { action: "hmac", type: "SHA256", value: "={{ $json.timestamp + '.' + $json.rawBody }}", dataPropertyName: "signature", secret: SECRET, encoding: "hex" }),
    code("Read the request", [660, 300], `
// A webhook call carries the exact bytes that were sent as a binary attachment, and the headers as fields.
// The signature covers those exact bytes, so re-serialising the parsed JSON would not match.
// The test run carries the same three things as plain fields.
const item = $input.first().json;
const isWebhook = !!item.headers;
let rawBody = item.rawBody;
if (isWebhook) {
  try { rawBody = (await this.helpers.getBinaryDataBuffer(0, 'data')).toString('utf8'); }
  catch (e) { rawBody = JSON.stringify(item.body); }
}
const timestamp = isWebhook ? item.headers['x-timestamp'] : item.timestamp;
const received = isWebhook ? item.headers['x-signature'] : 'sha256=' + item.signature;
return [{ json: { rawBody, timestamp, received } }];
`),
    node("Compute expected signature", "crypto", 1, [880, 300], { action: "hmac", type: "SHA256", value: "={{ $json.timestamp + '.' + $json.rawBody }}", dataPropertyName: "expected", secret: SECRET, encoding: "hex" }),
    code("Check and parse", [1100, 300], `
const j = $input.first().json;
const fail = (status, error) => [{ json: { ok: false, status, error } }];
if (!j.timestamp || !j.received) return fail(401, 'missing timestamp or signature');
if (Math.abs(Date.now() / 1000 - Number(j.timestamp)) > 300) return fail(401, 'timestamp is too old or too far in the future');
// Note: this string comparison is not constant time. See the README for what that means.
if ('sha256=' + j.expected !== j.received) return fail(401, 'signature does not match');
let o;
try { o = JSON.parse(j.rawBody); } catch (e) { return fail(400, 'body is not valid JSON'); }
if (!o.id || !o.customer || !o.customer.email || !Array.isArray(o.items) || !o.items.length) return fail(422, 'order is missing fields');
const sum = Math.round(o.items.reduce((s, i) => s + i.qty * i.unit_price, 0) * 100) / 100;
if (Math.abs(sum - o.total) > 0.01) return fail(422, 'total ' + o.total + ' does not match the items, which add up to ' + sum);
return [{ json: { ok: true, order: o } }];
`),
    set("Settings", [1320, 300], [["base_url", "http://localhost:8140"]], true),
    ifNode("Is it valid?", [1540, 300], "={{ $('Check and parse').first().json.ok }}", { type: "boolean", operation: "true", singleValue: true }, ""),
    http("Send to CRM", [1780, 200], "POST", `${BASE}/crm/contacts`,
      "={{ JSON.stringify({ email: $('Check and parse').first().json.order.customer.email, name: $('Check and parse').first().json.order.customer.name, last_order_id: $('Check and parse').first().json.order.id }) }}",
      { headers: [{ name: "Idempotency-Key", value: "={{ $('Check and parse').first().json.order.id + ':crm' }}" }], retry: true }),
    http("Send to accounting", [2020, 200], "POST", `${BASE}/accounting/invoices`,
      "={{ JSON.stringify({ reference: $('Check and parse').first().json.order.id, currency: $('Check and parse').first().json.order.currency, lines: $('Check and parse').first().json.order.items, status: 'draft' }) }}",
      { headers: [{ name: "Idempotency-Key", value: "={{ $('Check and parse').first().json.order.id + ':accounting' }}" }], retry: true }),
    http("Tell Slack", [2260, 200], "POST", `${BASE}/slack`,
      "={{ JSON.stringify({ text: 'New order ' + $('Check and parse').first().json.order.id + ': ' + $('Check and parse').first().json.order.total + ' ' + $('Check and parse').first().json.order.currency }) }}",
      { retry: true }),
    code("Summarise delivery", [2500, 200], `
// Each step passes its item on, even after its retries ran out, so the answer can say what failed.
const failed = ['Send to CRM', 'Send to accounting', 'Tell Slack'].filter((n) => $(n).first().json.error);
return [{ json: { status: 202, body: { accepted: true, order: $('Check and parse').first().json.order.id, failed } } }];
`),
    code("Refusal", [1780, 460], `const j = $('Check and parse').first().json; return [{ json: { status: j.status, body: { error: j.error } } }];`),
    node("Reply", "respondToWebhook", 1.1, [2740, 320], { respondWith: "json", responseBody: "={{ JSON.stringify($json.body) }}", options: { responseCode: "={{ $json.status }}" } }),
  ];
  write("2-signed-order-fan-out.json", workflow("Signed order webhook, checked and sent on", nodes, connect({
    "Order webhook": [["Read the request"]],
    "Test run": [["Sample order (test only)"]],
    "Sample order (test only)": [["Sign (test only)"]],
    "Sign (test only)": [["Read the request"]],
    "Read the request": [["Compute expected signature"]],
    "Compute expected signature": [["Check and parse"]],
    "Check and parse": [["Settings"]],
    Settings: [["Is it valid?"]],
    "Is it valid?": [["Send to CRM"], ["Refusal"]],
    "Send to CRM": [["Send to accounting"]],
    "Send to accounting": [["Tell Slack"]],
    "Tell Slack": [["Summarise delivery"]],
    "Summarise delivery": [["Reply"]],
    Refusal: [["Reply"]],
  })));
}

// ---------------------------------------------------------------------------------------------
// 3. Daily sales digest
{
  const nodes = [
    node("Every morning", "scheduleTrigger", 1.2, [0, 160], { rule: { interval: [{ field: "days", daysInterval: 1, triggerAtHour: 8 }] } }),
    node("Test run", "manualTrigger", 1, [0, 400], {}),
    set("Settings", [240, 280], [["base_url", "http://localhost:8140"]], true),
    http("Get yesterday's orders", [480, 280], "GET", `${BASE}/sales`, null, { retry: true, always: true }),
    code("Write the digest", [720, 280], `
// An empty list from the API arrives as one empty item, so only keep real orders.
const orders = $input.all().map((i) => i.json).filter((o) => o.id !== undefined && o.status !== 'cancelled');
if (!orders.length) return [{ json: { text: 'No orders yesterday.' } }];
const revenue = orders.reduce((s, o) => s + o.total, 0);
const byProduct = {};
for (const o of orders) for (const l of o.items) byProduct[l.product] = (byProduct[l.product] || 0) + l.amount;
const top = Object.entries(byProduct).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([p, v]) => p + ' ' + v.toFixed(2));
return [{ json: { text: 'Yesterday: ' + orders.length + ' orders, ' + revenue.toFixed(2) + ' revenue. Top products: ' + top.join(', ') + '.' } }];
`),
    http("Post to Slack", [960, 280], "POST", `${BASE}/slack`, "={{ JSON.stringify({ text: $json.text }) }}", { retry: true }),
  ];
  write("3-daily-sales-digest.json", workflow("Daily sales digest", nodes, connect({
    "Every morning": [["Settings"]],
    "Test run": [["Settings"]],
    Settings: [["Get yesterday's orders"]],
    "Get yesterday's orders": [["Write the digest"]],
    "Write the digest": [["Post to Slack"]],
  })));
}
console.log("workflows written");
