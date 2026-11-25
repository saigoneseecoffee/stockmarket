import worker from "./src/index.js";
// ---- mocks ----
const store = new Map();
globalThis.caches = { default: { match: async k => store.get(k.url)?.clone(), put: async (k, r) => store.set(k.url, r) } };
const days = []; const base = Date.UTC(2024, 10, 1) / 1000;
for (let i = 0; i < 520; i++) { const t = base + i * 86400; const w = new Date(t * 1000).getUTCDay(); if (w && w < 6) days.push(t + 14.5 * 3600); }
const closes = days.map((_, i) => 150 + i * 0.1 + 5 * Math.sin(i / 7));
let sheetCalls = [];
let anthropicCalls = 0;
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.includes("finance.yahoo")) return new Response(JSON.stringify({ chart: { result: [{ meta: { currency: "USD", gmtoffset: -18000, regularMarketPrice: 199.5, regularMarketTime: Date.now() / 1000, fullExchangeName: "NasdaqGS", longName: "Apple Inc." }, timestamp: days, indicators: { quote: [{ close: closes }], adjclose: [{ adjclose: closes }] } }] } }));
  if (url.includes("browse-edgar")) return new Response("<feed><company-info><cik>0000320193</cik></company-info></feed>");
  if (url.includes("submissions")) return new Response(JSON.stringify({ name: "Apple Inc.", sicDescription: "Electronic Computers", fiscalYearEnd: "0927", filings: { recent: { form: ["8-K", "10-Q", "4"], filingDate: ["2026-10-30", "2026-08-01", "2026-07-01"], reportDate: ["", "2026-06-28", ""], accessionNumber: ["0000320193-26-000100", "0000320193-26-000090", "x"], primaryDocument: ["a.htm", "b.htm", "c"], items: ["2.02", "", ""] } } }));
  if (url.includes("companyconcept")) {
    if (url.includes("/Revenues.json") || url.includes("SalesRevenueNet")) return new Response("", { status: 404 });
    const unit = url.includes("EarningsPerShare") ? "USD/shares" : "USD";
    return new Response(JSON.stringify({ tag: url.split("/").pop().replace(".json", ""), units: { [unit]: [
      { start: "2024-09-29", end: "2025-09-27", val: 416e9, form: "10-K", filed: "2025-10-31" },
      { start: "2023-10-01", end: "2024-09-28", val: 391e9, form: "10-K", filed: "2024-11-01" },
      { start: "2025-06-29", end: "2025-09-27", val: 102e9, form: "10-K", filed: "2025-10-31" },
      { start: "2026-03-29", end: "2026-06-27", val: 94e9, form: "10-Q", filed: "2026-08-01" },
      { start: "2025-03-30", end: "2025-06-28", val: 86e9, form: "10-Q", filed: "2025-08-01" },
      { end: "2026-06-27", val: 30e9, form: "10-Q", filed: "2026-08-01" } ] } }));
  }
  if (url.includes("api.anthropic.com")) {
    anthropicCalls++;
    const body = JSON.parse(init.body);
    if (anthropicCalls === 1) return new Response(JSON.stringify({ stop_reason: "pause_turn", content: [{ type: "server_tool_use", id: "s1", name: "web_search", input: { query: "AAPL news" } }, { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: "https://www.reuters.com/x", title: "Reuters AAPL", page_age: "Nov 20, 2026" }, { type: "web_search_result", url: "javascript:alert(1)", title: "bad" }] }], usage: { server_tool_use: { web_search_requests: 1 } } }));
    if (body.messages.length !== 2) throw new Error("pause_turn not continued");
    return new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: "Tóm lại", citations: [{ type: "web_search_result_location", url: "https://www.reuters.com/x", title: "Reuters AAPL" }] }, { type: "text", text: "\n```json\n" + JSON.stringify({ company: { name: "Apple" }, scenarios: [{ name: "Tích cực", prob: 0.3, return_pct: 7 }, { name: "Cơ sở", prob: 0.5, return_pct: 1 }, { name: "Tiêu cực", prob: 0.2, return_pct: -8 }], scores: { business: 9, growth: 6, financial: 9, valuation: 5, b2b: 8, b2c: 9, management: 8, risk: 7 }, confidence: "trung bình" }) + "\n```" }], usage: { server_tool_use: { web_search_requests: 2 } } }));
  }
  if (url.startsWith("https://script.google.com")) { const b = JSON.parse(init.body); sheetCalls.push(b);
    if (b.action === "list") return new Response(JSON.stringify({ rows: [{ id: "AAPL-abc123", ticker: "AAPL", targetDate: "2025-12-01", actual: "", median: 200, lo80: 180, hi80: 220 }] }));
    return new Response(JSON.stringify({ ok: true })); }
  throw new Error("unexpected fetch " + url);
};
const env = { ANTHROPIC_API_KEY: "k", APP_PIN: "2468", SHEET_URL: "https://script.google.com/macros/s/x/exec", SHEET_SECRET: "s", ALLOWED_ORIGIN: "https://saigoneseecoffee.github.io" };
const waits = []; const ctx = { waitUntil: p => waits.push(p) };
const call = (path, body, origin = "https://saigoneseecoffee.github.io") => worker.fetch(new Request("https://w.dev" + path, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) }), env, ctx);
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("ok:", m); };

let r = await call("/api/analyze", { ticker: "AAPL", pin: "0000" }); assert(r.status === 401, "wrong pin -> 401");
r = await call("/api/analyze", { ticker: "AAPL", pin: "2468" }, "https://evil.com"); assert(r.status === 403, "bad origin -> 403");
r = await call("/api/analyze", { ticker: "<script>", pin: "2468" }); assert(r.status === 400, "bad ticker -> 400");
r = await call("/api/analyze", { ticker: "aapl", pin: "2468" }); const j = await r.json();
assert(r.status === 200, "analyze 200 " + (j.message || ""));
assert(j.price === 199.5, "live price used for today");
assert(j.sec.facts.revenue.annual[0].value === 416e9 && j.sec.facts.revenue.annual.length === 2, "SEC annual revenue (quarter in 10-K excluded)");
assert(j.sec.facts.revenue.lastQ.value === 94e9 && j.sec.facts.revenue.lastQYearAgo.value === 86e9, "SEC last quarter + YoY");
assert(j.sec.filings.length === 2 && j.sec.filings[0].url.startsWith("https://www.sec.gov/Archives/edgar/data/320193/"), "filings filtered + links");
assert(j.sources.length === 1 && j.sources[0].cited, "sources: https only, cited flag");
assert(j.searches === 3, "search count summed across pause_turn");
assert(j.total === 76 && j.verdict.cls === "good", "score + verdict " + j.total);
assert(Math.abs(j.forecast.b80[1] / j.forecast.b80[0] - Math.exp(2 * 1.2816 * j.forecast.sdDaily * Math.sqrt(j.T))) < 1e-9, "band width matches sigma");
await Promise.all(waits);
assert(sheetCalls[0]?.action === "append" && sheetCalls[0].secret === "s" && sheetCalls[0].row.ticker === "AAPL", "sheet append with secret");
r = await call("/api/history", { pin: "2468" }); const hj = await r.json();
assert(hj.rows[0].actual > 0 && hj.rows[0].actualDate >= "2025-12-01", "history fills actual " + hj.rows[0].actual + " " + hj.rows[0].actualDate);
assert(sheetCalls.some(c => c.action === "setActual"), "setActual written to sheet");
r = await call("/api/report", { pin: "2468", id: "../../etc" }); assert(r.status === 400, "bad report id -> 400");

