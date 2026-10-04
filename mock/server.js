// Stand in versions of a CRM, an accounting tool, Slack and a spreadsheet, so the workflows can be
// run and tested with no accounts. Start it with: node mock/server.js  (port 8140)
const http = require("http");

function createMock() {
  let state;
  const reset = (opts = {}) => {
    state = { received: { crm: [], accounting: [], slack: [], sheets: [] }, calls: { crm: 0, accounting: 0, slack: 0, sheets: 0 }, keys: new Set(), failFirst: opts.failFirst || {}, sales: opts.sales || SALES };
  };
  const SALES = [
    { id: 1, status: "delivered", total: 162.5, items: [{ product: "Standing desk", amount: 120 }, { product: "Cable kit", amount: 42.5 }] },
    { id: 2, status: "delivered", total: 310, items: [{ product: "Standing desk", amount: 310 }] },
    { id: 3, status: "cancelled", total: 999, items: [{ product: "Office chair", amount: 999 }] },
    { id: 4, status: "shipped", total: 85, items: [{ product: "Laptop stand", amount: 85 }] },
  ];
  reset();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      const url = req.url.split("?")[0];
      if (req.method === "GET" && url === "/sales") return send(200, state.sales);
      if (req.method === "GET" && url === "/__received") return send(200, { received: state.received, calls: state.calls });
      if (req.method === "POST" && url === "/__reset") { reset(body ? JSON.parse(body) : {}); return send(200, { ok: true }); }
      const name = { "/crm/contacts": "crm", "/accounting/invoices": "accounting", "/slack": "slack", "/sheets": "sheets" }[url];
      if (req.method !== "POST" || !name) return send(404, { error: "not found" });
      let data; try { data = JSON.parse(body || "{}"); } catch { return send(400, { error: "invalid json" }); }
      state.calls[name] += 1;
      if (state.calls[name] <= (state.failFirst[name] || 0)) return send(503, { error: "service unavailable" });
      if (name === "accounting" && !["GBP", "USD", "EUR"].includes(data.currency)) return send(422, { error: `unsupported currency ${data.currency}` });
      const key = req.headers["idempotency-key"];
      if (key && (name === "crm" || name === "accounting")) {
        if (state.keys.has(key)) return send(200, { duplicate: true });
        state.keys.add(key);
      }
      state.received[name].push({ headers: { "idempotency-key": key }, body: data });
      send(201, { ok: true });
    });
  });
  return { server, reset, get: () => ({ received: state.received, calls: state.calls }) };
}

module.exports = { createMock };
if (require.main === module) {
  const m = createMock();
  m.server.listen(8140, () => console.log("mock services on http://localhost:8140"));
}
