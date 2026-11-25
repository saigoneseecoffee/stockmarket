// Soi Cổ Phiếu 360° — Cloudflare Worker (US stocks only)
// Holds every secret: Anthropic API key, app PIN, Google Sheet URL + secret.
// Free version: no Claude API. The Worker fetches prices (Yahoo/Stooq) and SEC data,
// computes the 1-month volatility cone, and logs to Google Sheet. The written analysis
// comes from Claude chat (user copies a prompt, pastes Claude's JSON back) via /api/save.
// Endpoints (all POST, JSON):  /api/analyze   /api/save   /api/history   /api/report
//
// Secrets (wrangler secret put …): APP_PIN, SHEET_URL, SHEET_SECRET
// Vars (wrangler.toml): ALLOWED_ORIGIN, DAILY_LIMIT, SEC_USER_AGENT
// Optional KV binding RL: daily usage cap + wrong-PIN lockout.

import { forecast, totalScore, verdictOf, quantStats, addMonth, tradingDaysBetween, isoDate, parseISO } from "./calc.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const TICKER_RE = /^[A-Z]{1,6}([.\-][A-Z]{1,2})?$/;

export default {
  async fetch(req, env, ctx) {
    const origin = req.headers.get("origin") || "";
    const allowed = (env.ALLOWED_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
    const okOrigin = allowed.length === 0 || allowed.includes(origin);
    const cors = {
      "access-control-allow-origin": okOrigin && origin ? origin : (allowed[0] || "*"),
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "86400",
      "vary": "origin",
    };
    const reply = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...JSON_HEADERS, ...cors } });

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/") return reply({ ok: true, service: "soicophieu" });
    if (req.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
    if (!okOrigin) return reply({ error: "forbidden_origin" }, 403);

    let body;
    try {
      const text = await req.text();
      if (text.length > 250000) return reply({ error: "too_large" }, 413);
      body = JSON.parse(text);
    } catch { return reply({ error: "bad_json" }, 400); }

    // ---- PIN check with lockout ----
    const ip = req.headers.get("cf-connecting-ip") || "unknown";
    const lockKey = `fail:${ip}:${new Date().toISOString().slice(0, 13)}`;
    if (env.RL) {
      const fails = Number(await env.RL.get(lockKey)) || 0;
      if (fails >= 8) return reply({ error: "locked", message: "Sai PIN quá nhiều lần. Thử lại sau 1 giờ." }, 429);
    }
    if (!env.APP_PIN || !safeEqual(String(body.pin || ""), env.APP_PIN)) {
      if (env.RL) { const f = (Number(await env.RL.get(lockKey)) || 0) + 1; await env.RL.put(lockKey, String(f), { expirationTtl: 3700 }); }
      return reply({ error: "bad_pin", message: "Sai mã PIN." }, 401);
    }

    try {
      if (url.pathname === "/api/analyze") return reply(await analyze(body, env, ctx));
      if (url.pathname === "/api/save") return reply(await save(body, env));
      if (url.pathname === "/api/history") return reply(await history(env));
      if (url.pathname === "/api/report") return reply(await getReport(body, env));
      return reply({ error: "not_found" }, 404);
    } catch (e) {
      const status = e.status || 500;
      return reply({ error: e.code || "server_error", message: e.publicMessage || "Lỗi máy chủ, thử lại sau." }, status);
    }
  },
};

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function fail(status, code, publicMessage) { const e = new Error(code); e.status = status; e.code = code; e.publicMessage = publicMessage; return e; }
function todayET() {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return p; // YYYY-MM-DD
}

// ---------------- analyze ----------------
async function analyze(body, env, ctx) {
  const ticker = String(body.ticker || "").trim().toUpperCase();
  if (!TICKER_RE.test(ticker)) throw fail(400, "bad_ticker", "Mã cổ phiếu Mỹ không hợp lệ (VD: AAPL, BRK.B).");
  const today = todayET();
  let checkDate = String(body.checkDate || today);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkDate) || checkDate > today) checkDate = today;
  if (checkDate < "2000-01-01") throw fail(400, "bad_date", "Ngày kiểm tra không hợp lệ.");
  
  // daily cap
  if (env.RL) {
    const k = `day:${today}`; const n = Number(await env.RL.get(k)) || 0;
    const cap = Number(env.DAILY_LIMIT || 100);
    if (n >= cap) throw fail(429, "daily_limit", `Đã dùng hết ${cap} lượt hôm nay.`);
    await env.RL.put(k, String(n + 1), { expirationTtl: 172800 });
  }

  const [quote, sec] = await Promise.all([
    getQuote(ticker, checkDate, today),
    getSEC(ticker, env).catch(() => null),
  ]);
  if (!quote) throw fail(404, "no_price", "Không tìm thấy dữ liệu giá cho mã này trên thị trường Mỹ.");

  const target = addMonth(parseISO(checkDate));
  const T = Math.max(1, tradingDaysBetween(parseISO(checkDate), target));
  const q = quantStats(quote.dates, quote.closes);

  const sdDaily = q && q.n > 20 ? q.sdDaily : 0.3 / Math.sqrt(252);
  const volSrc = q && q.n > 20 ? `tính từ ${Math.min(60, q.n - 1)} phiên gần nhất (Yahoo Finance)` : "mặc định 30%/năm (thiếu dữ liệu giá)";
  const fc = forecast(quote.price, sdDaily, T, null);

  const id = `${ticker}-${Date.now().toString(36)}`;
  const result = {
    id, ticker, checkDate, targetDate: isoDate(target), T, createdAt: new Date().toISOString(),
    price: quote.price, priceNote: quote.priceNote, currency: quote.currency, exchange: quote.exchange, name: quote.name || sec?.name || ticker,
    history: { d: quote.dates.slice(-120), c: quote.closes.slice(-120) },
    stats: q, sec, report: null,
    forecast: { mu: fc.mu, muRaw: fc.muRaw, clamped: fc.clamped, sdDaily, volSrc, median: fc.median, b50: fc.b50, b80: fc.b80, b95: fc.b95, probUp: fc.probUp, scenarios: [] },
    total: null, verdict: null,
  };

  if (env.SHEET_URL && env.SHEET_SECRET) {
    const row = {
      id, createdAt: result.createdAt, ticker, name: result.name, checkDate, targetDate: result.targetDate,
      price: round(quote.price), median: round(fc.median), lo80: round(fc.b80[0]), hi80: round(fc.b80[1]),
      probUp: Math.round(fc.probUp * 100), score: "", verdict: "Chưa có phân tích Claude", confidence: "", model: "chỉ dữ liệu",
    };
    const reportJson = JSON.stringify(result);
    ctx.waitUntil(sheetPost(env, { action: "append", row, report: reportJson.length < 45000 ? reportJson : "" }).catch(() => {}));
  }
  return result;
}
const round = v => Math.round(v * 100) / 100;

// ---------------- prices (Yahoo, Stooq fallback) ----------------
async function getQuote(ticker, checkDate, today) {
  const y = ticker.replace(".", "-");
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(y)}?range=2y&interval=1d&includeAdjustedClose=true`, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; soicophieu/1.0)", accept: "application/json" },
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (r.ok) {
      const j = await r.json();
      const res = j?.chart?.result?.[0];
      if (res?.timestamp?.length) {
        const meta = res.meta || {};
        if (meta.currency && meta.currency !== "USD") return null; // US market only
        const adj = res.indicators?.adjclose?.[0]?.adjclose;
        const cls = res.indicators?.quote?.[0]?.close || [];
        const dates = [], closes = [];
        res.timestamp.forEach((t, i) => {
          const v = (adj && adj[i] != null) ? adj[i] : cls[i];
          if (v != null && v > 0) { dates.push(isoDate(new Date((t + (meta.gmtoffset || -18000)) * 1000))); closes.push(v); }
        });
        return pickPrice({ dates, closes, meta, checkDate, today, source: "Yahoo Finance" });
      }
    }
  } catch { /* fall through */ }
  try {
    const r = await fetch(`https://stooq.com/q/d/l/?s=${encodeURIComponent(ticker.toLowerCase().replace(".", "-"))}.us&i=d`);
    if (!r.ok) return null;
    const lines = (await r.text()).trim().split(/\r?\n/).slice(1);
    const dates = [], closes = [];
    for (const l of lines.slice(-520)) { const c = l.split(","); const v = Number(c[4]); if (/^\d{4}-\d{2}-\d{2}$/.test(c[0]) && v > 0) { dates.push(c[0]); closes.push(v); } }
    if (dates.length < 5) return null;
    return pickPrice({ dates, closes, meta: {}, checkDate, today, source: "Stooq" });
  } catch { return null; }
}
function pickPrice({ dates, closes, meta, checkDate, today, source }) {
  // keep only data up to the check date (no look-ahead)
  let n = dates.length; while (n > 0 && dates[n - 1] > checkDate) n--;
  if (n === 0) return null;
  const d = dates.slice(0, n), c = closes.slice(0, n);
  let price = c[n - 1], priceNote = `giá đóng cửa ${d[n - 1]} (${source}, đã điều chỉnh)`;
  if (checkDate === today && Number(meta.regularMarketPrice) > 0) {
    price = Number(meta.regularMarketPrice);
    const t = meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toLocaleString("vi-VN", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }) : "";
    priceNote = `giá thị trường ${t} giờ New York (${source}, có thể trễ ~15 phút)`;
    if (d[n - 1] !== checkDate) { d.push(checkDate); c.push(price); } else c[c.length - 1] = price;
  }
  return { dates: d, closes: c, price, priceNote, currency: "USD", exchange: meta.fullExchangeName || meta.exchangeName || "", name: meta.longName || meta.shortName || "" };
}

// ---------------- SEC EDGAR ----------------
const CONCEPTS = [
  ["revenue", ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet"], "flow", "USD"],
  ["grossProfit", ["GrossProfit"], "flow", "USD"],
  ["operatingIncome", ["OperatingIncomeLoss"], "flow", "USD"],
  ["netIncome", ["NetIncomeLoss"], "flow", "USD"],
  ["epsDiluted", ["EarningsPerShareDiluted"], "flow", "USD/shares"],
  ["operatingCashFlow", ["NetCashProvidedByUsedInOperatingActivities"], "flow", "USD"],
  ["capex", ["PaymentsToAcquirePropertyPlantAndEquipment"], "flow", "USD"],
  ["cash", ["CashAndCashEquivalentsAtCarryingValue"], "instant", "USD"],
  ["longTermDebt", ["LongTermDebtNoncurrent", "LongTermDebt"], "instant", "USD"],
  ["equity", ["StockholdersEquity"], "instant", "USD"],
];
async function secFetch(url, env, ttl = 43200) {
  const cache = caches.default; const key = new Request(url);
  const hit = await cache.match(key); if (hit) return hit.json();
  const r = await fetch(url, { headers: { "user-agent": env.SEC_USER_AGENT || "soicophieu admin@example.com", accept: "application/json" } });
  if (!r.ok) return null;
  const text = await r.text();
  await cache.put(key, new Response(text, { headers: { "content-type": "application/json", "cache-control": `max-age=${ttl}` } }));
  return JSON.parse(text);
}
async function getCIK(ticker, env) {
  const r = await fetch(`https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(ticker.replace(".", "-"))}&type=10-K&dateb=&owner=include&count=1&output=atom`,
    { headers: { "user-agent": env.SEC_USER_AGENT || "soicophieu admin@example.com" }, cf: { cacheTtl: 86400, cacheEverything: true } });
  if (!r.ok) return null;
  const m = (await r.text()).match(/<cik>(\d+)<\/cik>/i);
  return m ? m[1].padStart(10, "0") : null;
}
async function getSEC(ticker, env) {
  const cik = await getCIK(ticker, env);
  if (!cik) return null;
  const sub = await secFetch(`https://data.sec.gov/submissions/CIK${cik}.json`, env, 21600);
  const out = { cik, name: sub?.name || "", sic: sub?.sicDescription || "", fiscalYearEnd: sub?.fiscalYearEnd || "", filings: [], facts: {} };
  const rec = sub?.filings?.recent;
  if (rec?.form) {
    for (let i = 0; i < rec.form.length && out.filings.length < 10; i++) {
      if (!["10-K", "10-Q", "8-K", "DEF 14A", "S-1", "20-F", "6-K"].includes(rec.form[i])) continue;
      const acc = rec.accessionNumber[i].replace(/-/g, "");
      out.filings.push({ form: rec.form[i], filed: rec.filingDate[i], period: rec.reportDate[i] || "", items: rec.items?.[i] || "",
        url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${acc}/${rec.primaryDocument[i]}` });
    }
  }
  const results = await Promise.all(CONCEPTS.map(async ([key, tags, kind, unit]) => {
    const cands = await Promise.all(tags.map(t => secFetch(`https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/${t}.json`, env).catch(() => null)));
    let best = null;
    for (const c of cands) {
      const arr = c?.units?.[unit]; if (!arr?.length) continue;
      const latestEnd = arr.reduce((m, x) => x.end > m ? x.end : m, "");
      if (!best || latestEnd > best.latestEnd) best = { arr, latestEnd, tag: c.tag };
    }
    if (!best) return [key, null];
    return [key, summarizeConcept(best.arr, kind, best.tag)];
  }));
  for (const [k, v] of results) if (v) out.facts[k] = v;
  return out;
}
function summarizeConcept(arr, kind, tag) {
  const days = x => x.start ? (Date.parse(x.end) - Date.parse(x.start)) / 864e5 : 0;
  const byEnd = new Map();
  if (kind === "flow") {
    // annual: ~1 year duration from 10-K; latest quarter: ~3 months from 10-Q
    for (const x of arr) if (x.form === "10-K" && days(x) > 340 && days(x) < 380) { const p = byEnd.get(x.end); if (!p || x.filed > p.filed) byEnd.set(x.end, x); }
    const annual = [...byEnd.values()].sort((a, b) => b.end.localeCompare(a.end)).slice(0, 4).map(x => ({ period: `FY kết thúc ${x.end}`, value: x.val, form: x.form, filed: x.filed }));
    const qs = arr.filter(x => x.form === "10-Q" && days(x) > 80 && days(x) < 100).sort((a, b) => b.end.localeCompare(a.end) || b.filed.localeCompare(a.filed));
    const lastQ = qs[0] ? { period: `quý kết thúc ${qs[0].end}`, value: qs[0].val, form: "10-Q", filed: qs[0].filed } : null;
    const yoyQ = lastQ ? qs.find(x => Math.abs(Date.parse(qs[0].end) - Date.parse(x.end) - 365 * 864e5) < 20 * 864e5) : null;
    return { tag, annual, lastQ, lastQYearAgo: yoyQ ? { period: `quý kết thúc ${yoyQ.end}`, value: yoyQ.val } : null };
  }
  const latest = arr.filter(x => x.form === "10-K" || x.form === "10-Q").sort((a, b) => b.end.localeCompare(a.end) || b.filed.localeCompare(a.filed))[0];
  return latest ? { tag, latest: { period: `tại ${latest.end}`, value: latest.val, form: latest.form, filed: latest.filed } } : null;
}

// ---------------- Google Sheet ----------------
async function sheetPost(env, payload) {
  const r = await fetch(env.SHEET_URL, { method: "POST", headers: { "content-type": "text/plain;charset=utf-8" }, body: JSON.stringify({ ...payload, secret: env.SHEET_SECRET }), redirect: "follow" });
  const t = await r.text();
  try { return JSON.parse(t); } catch { throw fail(502, "sheet_error", "Google Sheet không phản hồi đúng."); }
}
async function history(env) {
  if (!env.SHEET_URL) return { rows: [], note: "Chưa kết nối Google Sheet." };
  const res = await sheetPost(env, { action: "list" });
  const rows = Array.isArray(res.rows) ? res.rows : [];
  // fill actual prices for rows whose target date has passed
  const today = todayET();
  const due = rows.filter(r => r.targetDate && r.targetDate < today && (r.actual === "" || r.actual == null)).slice(0, 10);
  const byTicker = {};
  for (const r of due) {
    if (!(r.ticker in byTicker)) byTicker[r.ticker] = await getQuote(r.ticker, today, "0000-00-00").catch(() => null); // full closes, no live price
    const h = byTicker[r.ticker]; if (!h) continue;
    const i = h.dates.findIndex(d => d >= r.targetDate); // first trading day on/after target
    if (i < 0) continue;
    const actual = round(h.closes[i]);
    r.actual = actual; r.actualDate = h.dates[i];
    await sheetPost(env, { action: "setActual", id: r.id, actual, actualDate: h.dates[i] }).catch(() => {});
  }
  return { rows };
}
// Save Claude's analysis (pasted by the user) and recompute the forecast with its scenarios.
async function save(body, env) {
  const r = body.result;
  if (!r || typeof r !== "object") throw fail(400, "bad_result", "Thiếu dữ liệu báo cáo.");
  const id = String(r.id || "");
  if (!/^[A-Z.\-]{1,9}-[a-z0-9]{6,12}$/.test(id)) throw fail(400, "bad_id", "Mã báo cáo không hợp lệ.");
  const R = r.report;
  if (!R || typeof R !== "object" || Array.isArray(R)) throw fail(400, "bad_report", "Phân tích của Claude không đúng định dạng.");
  const price = Number(r.price), sd = Number(r.forecast?.sdDaily), T = Number(r.T);
  if (!(price > 0 && sd > 0 && sd < 1 && T > 0 && T < 40)) throw fail(400, "bad_numbers", "Số liệu không hợp lệ.");
  const fc = forecast(price, sd, T, R.scenarios);
  const total = totalScore(R.scores);
  const verdict = verdictOf(total, fc.mu);
  const result = { ...r, report: R, total, verdict, analyzedAt: new Date().toISOString(),
    forecast: { ...r.forecast, mu: fc.mu, muRaw: fc.muRaw, clamped: fc.clamped, median: fc.median, b50: fc.b50, b80: fc.b80, b95: fc.b95, probUp: fc.probUp, scenarios: fc.scenarios } };
  const json = JSON.stringify(result);
  if (json.length > 200000) throw fail(413, "too_large", "Báo cáo quá dài.");
  let saved = false;
  if (env.SHEET_URL && env.SHEET_SECRET) {
    const res = await sheetPost(env, { action: "update", id, row: { median: round(fc.median), lo80: round(fc.b80[0]), hi80: round(fc.b80[1]),
      probUp: Math.round(fc.probUp * 100), score: total ?? "", verdict: verdict.t, confidence: String(R.confidence || ""), model: "Claude chat" },
      report: json.length < 45000 ? json : "" }).catch(() => null);
    saved = !!res?.ok;
  }
  return { result, saved };
}

async function getReport(body, env) {
  const id = String(body.id || "");
  if (!/^[A-Z.\-]{1,9}-[a-z0-9]{6,12}$/.test(id)) throw fail(400, "bad_id", "Mã báo cáo không hợp lệ.");
  if (!env.SHEET_URL) throw fail(404, "no_sheet", "Chưa kết nối Google Sheet.");
  const res = await sheetPost(env, { action: "get", id });
  if (!res.report) throw fail(404, "not_found", "Không tìm thấy báo cáo (có thể quá dài để lưu).");
  return JSON.parse(res.report);
}
