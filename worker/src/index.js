// Soi Cổ Phiếu 360° — Cloudflare Worker (US stocks only)
// Holds every secret: Anthropic API key, app PIN, Google Sheet URL + secret.
// Endpoints (all POST, JSON):  /api/analyze   /api/history   /api/report
//
// Secrets (wrangler secret put …): ANTHROPIC_API_KEY, APP_PIN, SHEET_URL, SHEET_SECRET
// Vars (wrangler.toml): ALLOWED_ORIGIN, MODEL, DAILY_LIMIT, SEC_USER_AGENT, MAX_SEARCHES
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
      if (text.length > 20000) return reply({ error: "too_large" }, 413);
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
  const notes = String(body.notes || "").slice(0, 4000);

  // daily cap
  if (env.RL) {
    const k = `day:${today}`; const n = Number(await env.RL.get(k)) || 0;
    const cap = Number(env.DAILY_LIMIT || 30);
    if (n >= cap) throw fail(429, "daily_limit", `Đã dùng hết ${cap} lượt phân tích hôm nay.`);
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

  const claude = await askClaude({ ticker, checkDate, today, target: isoDate(target), T, quote, q, sec, notes }, env);
  const R = claude.report || {};

  const sdDaily = q && q.n > 20 ? q.sdDaily : (Number(R.annual_volatility_pct) > 0 ? Number(R.annual_volatility_pct) / 100 / Math.sqrt(252) : 0.3 / Math.sqrt(252));
  const volSrc = q && q.n > 20 ? `tính từ ${Math.min(60, q.n - 1)} phiên gần nhất (Yahoo Finance)` : "AI ước tính";
  const fc = forecast(quote.price, sdDaily, T, R.scenarios);
  const total = totalScore(R.scores);
  const verdict = verdictOf(total, fc.mu);

  const id = `${ticker}-${Date.now().toString(36)}`;
  const result = {
    id, ticker, checkDate, targetDate: isoDate(target), T, createdAt: new Date().toISOString(),
    price: quote.price, priceNote: quote.priceNote, currency: quote.currency, exchange: quote.exchange, name: quote.name || sec?.name || ticker,
    history: { d: quote.dates.slice(-120), c: quote.closes.slice(-120) },
    stats: q, sec, report: R, sources: claude.sources, model: claude.model, searches: claude.searches,
    forecast: { mu: fc.mu, muRaw: fc.muRaw, clamped: fc.clamped, sdDaily, volSrc, median: fc.median, b50: fc.b50, b80: fc.b80, b95: fc.b95, probUp: fc.probUp, scenarios: fc.scenarios },
    total, verdict,
  };

  if (env.SHEET_URL && env.SHEET_SECRET) {
    const row = {
      id, createdAt: result.createdAt, ticker, name: result.name, checkDate, targetDate: result.targetDate,
      price: round(quote.price), median: round(fc.median), lo80: round(fc.b80[0]), hi80: round(fc.b80[1]),
      probUp: Math.round(fc.probUp * 100), score: total ?? "", verdict: verdict.t, confidence: R.confidence || "", model: claude.model,
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

// ---------------- Claude ----------------
const SCHEMA = `{"company":{"name":"","ticker":"","exchange":"","sector":"","industry":"","hq":"","founded":"","employees":"","one_liner":"1 câu","description":"3-4 câu"},
"business_model":{"summary":"","period":"FY...","revenue_streams":[{"name":"","share_pct":0,"type":"B2B|B2C|B2G|Hỗn hợp","note":""}],"geography":[{"region":"","share_pct":0}]},
"b2b":{"summary":"vai trò trong chuỗi giá trị","customers":[{"name":"","relation":"","importance":"cao|trung bình|thấp"}],"suppliers":[{"name":"","relation":"","importance":""}],"partners":[{"name":"","relation":"","importance":""}],"concentration_risk":"","switching_costs":""},
"b2c":{"applicable":true,"summary":"","products":[{"name":"","note":""}],"channels":[""],"customer_base":"","brand_strength":"","pricing_power":""},
"moat":{"rating":"rộng|hẹp|không có","sources":[""],"summary":""},
"competitors":[{"name":"","ticker":"","note":""}],
"industry":{"tam":"","growth":"","trends":[""]},
"management":{"ceo":"","summary":"","insider_ownership":"","capital_allocation":""},
"risks":[{"title":"","detail":"","severity":"cao|trung bình|thấp"}],
"esg":"",
"news":[{"date":"YYYY-MM-DD","title":"","summary":"","impact":"tích cực|tiêu cực|trung tính"}],
"analyst":{"consensus":"","avg_target":null,"low_target":null,"high_target":null,"num_analysts":null,"as_of":"","source":""},
"financials":{"period":"","metrics":[{"label":"","value":"","trend":"tăng|giảm|đi ngang|","source":"SEC 10-K|SEC 10-Q|tin tức"}]},
"growth":{"summary":"","drivers":[""],"catalysts":[{"title":"","detail":"","date":"","impact":"tích cực|tiêu cực|không rõ"}]},
"valuation":{"summary":"","metrics":[{"label":"P/E","company":"","benchmark":""}],"fair_value_low":null,"fair_value_high":null,"method":""},
"annual_volatility_pct":null,
"scenarios":[{"name":"Tích cực","prob":0.25,"return_pct":0,"drivers":""},{"name":"Cơ sở","prob":0.5,"return_pct":0,"drivers":""},{"name":"Tiêu cực","prob":0.25,"return_pct":0,"drivers":""}],
"scores":{"business":0,"growth":0,"financial":0,"valuation":0,"b2b":0,"b2c":0,"management":0,"risk":0},
"score_notes":{"business":"","growth":"","financial":"","valuation":"","b2b":"","b2c":"","management":"","risk":""},
"thesis":{"bull":[""],"bear":[""]},
"watch_next_month":[""],
"confidence":"cao|trung bình|thấp",
"data_gaps":[""]}`;

function buildPrompt(x) {
  const { ticker, checkDate, today, target, T, quote, q, sec, notes } = x;
  const pct = v => v == null ? "—" : (v * 100).toFixed(1) + "%";
  const past = checkDate < today;
  return `Bạn là chuyên viên phân tích cổ phiếu Mỹ độc lập. Viết TIẾNG VIỆT, rõ ràng, cho nhà đầu tư cá nhân.
Mã: ${ticker}. Ngày kiểm tra: ${checkDate}. Ngày mục tiêu: ${target} (~${T} phiên). Hôm nay: ${today}.
${past ? `CHÚ Ý: ngày kiểm tra nằm trong quá khứ — chỉ dùng thông tin công bố TRƯỚC hoặc ĐÚNG ngày ${checkDate}, bỏ qua mọi tin sau ngày đó.\n` : ""}
GIÁ (${quote.priceNote}): ${quote.price}
Thống kê giá thật: lợi suất 1T ${pct(q?.r1m)}, 3T ${pct(q?.r3m)}, 6T ${pct(q?.r6m)}, 1N ${pct(q?.r1y)}; SMA20 ${q?.sma20?.toFixed(2) ?? "—"}, SMA50 ${q?.sma50?.toFixed(2) ?? "—"}, SMA200 ${q?.sma200?.toFixed(2) ?? "—"}; đỉnh/đáy 52 tuần ${q?.hi?.toFixed(2)}/${q?.lo?.toFixed(2)}; biến động năm ${pct(q?.annVol)}.

SỐ LIỆU CHÍNH THỨC TỪ SEC EDGAR (đơn vị USD, chính xác — ưu tiên dùng, đừng mâu thuẫn):
${sec ? JSON.stringify({ name: sec.name, sic: sec.sic, fiscalYearEnd: sec.fiscalYearEnd, facts: sec.facts, recentFilings: sec.filings.map(f => `${f.form} nộp ${f.filed}${f.items ? " items " + f.items : ""}`) }) : "không lấy được"}
${notes ? `\nGHI CHÚ CỦA NGƯỜI DÙNG:\n"""${notes}"""\n` : ""}
VIỆC CẦN LÀM:
1. Dùng công cụ web_search để tra thông tin MỚI: tin tức 30 ngày gần nhất, kết quả quý gần nhất và dự báo (guidance), ngày công bố kết quả tiếp theo, đồng thuận & giá mục tiêu của giới phân tích, khách hàng/nhà cung cấp/đối tác lớn (theo 10-K), cơ cấu doanh thu theo mảng, đối thủ, P/E & các chỉ số định giá hiện tại so với ngành. Ưu tiên nguồn gốc: sec.gov, trang quan hệ nhà đầu tư của công ty, Reuters, AP, CNBC, WSJ, Bloomberg, Barron's, Yahoo Finance.
2. Tính các chỉ số tài chính từ số liệu SEC ở trên (doanh thu, tăng trưởng, biên lợi nhuận, FCF = dòng tiền HĐKD − capex, nợ/vốn chủ…), ghi rõ kỳ.
3. Không bịa: không chắc thì để null hoặc ghi "ước tính". Mỗi số phải kèm kỳ.
4. Kịch bản 1 tháng: đúng 3 kịch bản, xác suất cộng = 1, return_pct là % thay đổi giá đến ngày mục tiêu, hợp lý với biến động 1 tháng thực tế (${pct(q ? q.sdDaily * Math.sqrt(T) : null)} là 1 độ lệch chuẩn). Tính đến sự kiện trong 1 tháng tới (báo cáo KQKD, Fed, ra mắt sản phẩm…).
5. scores 0-10 (10 tốt nhất; "risk": 10 = rất an toàn; "b2c"/"b2b": null nếu công ty không có mảng đó). Giới hạn: ≤6 mục mỗi danh sách, ≤6 rủi ro, ≤5 đối thủ, ≤6 tin.

KẾT THÚC bằng DUY NHẤT một khối JSON (không markdown, không chữ nào sau nó) đúng cấu trúc:
${SCHEMA}`;
}

async function askClaude(x, env) {
  if (!env.ANTHROPIC_API_KEY) throw fail(500, "no_api_key", "Máy chủ chưa cấu hình khoá API Claude.");
  const model = env.MODEL || "claude-sonnet-5-5";
  const tools = [{ type: "web_search_20250305", name: "web_search", max_uses: Number(env.MAX_SEARCHES || 8), user_location: { type: "approximate", country: "US", timezone: "America/New_York" } }];
  const messages = [{ role: "user", content: buildPrompt(x) }];
  const content = []; let searches = 0;
  for (let round = 0; round < 4; round++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 16000, tools, messages }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      if (r.status === 429 || r.status === 529) throw fail(503, "claude_busy", "Claude đang quá tải, thử lại sau ít phút.");
      throw fail(502, "claude_error", `Claude API lỗi (${r.status}). ${t.slice(0, 160)}`);
    }
    const j = await r.json();
    content.push(...(j.content || []));
    searches += j.usage?.server_tool_use?.web_search_requests || 0;
    if (j.stop_reason === "pause_turn") { messages.push({ role: "assistant", content: j.content }); continue; }
    break;
  }
  // sources: search results + citations
  const seen = new Map();
  for (const b of content) {
    if (b.type === "web_search_tool_result" && Array.isArray(b.content)) for (const s of b.content) if (s.url && !seen.has(s.url)) seen.set(s.url, { url: s.url, title: s.title || s.url, age: s.page_age || "", cited: false });
    if (b.type === "text" && Array.isArray(b.citations)) for (const c of b.citations) if (c.url) { const s = seen.get(c.url) || { url: c.url, title: c.title || c.url, age: "" }; s.cited = true; seen.set(c.url, s); }
  }
  const sources = [...seen.values()].filter(s => /^https:\/\//.test(s.url)).sort((a, b) => (b.cited - a.cited)).slice(0, 25);
  // final JSON: the text after the last tool result
  let lastTool = -1; content.forEach((b, i) => { if (b.type === "web_search_tool_result" || b.type === "server_tool_use") lastTool = i; });
  const finalText = content.slice(lastTool + 1).filter(b => b.type === "text").map(b => b.text).join("");
  const report = extractJSON(finalText) || extractJSON(content.filter(b => b.type === "text").map(b => b.text).join(""));
  if (!report) throw fail(502, "bad_report", "Claude trả về sai định dạng. Bấm Phân tích lại.");
  return { report, sources, model, searches };
}
function extractJSON(t) {
  if (!t) return null;
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const cands = [fence?.[1], t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)].filter(Boolean);
  for (const c of cands) { try { const v = JSON.parse(c); if (v && typeof v === "object") return v; } catch { } }
  return null;
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
async function getReport(body, env) {
  const id = String(body.id || "");
  if (!/^[A-Z.\-]{1,9}-[a-z0-9]{6,12}$/.test(id)) throw fail(400, "bad_id", "Mã báo cáo không hợp lệ.");
  if (!env.SHEET_URL) throw fail(404, "no_sheet", "Chưa kết nối Google Sheet.");
  const res = await sheetPost(env, { action: "get", id });
  if (!res.report) throw fail(404, "not_found", "Không tìm thấy báo cáo (có thể quá dài để lưu).");
  return JSON.parse(res.report);
}
