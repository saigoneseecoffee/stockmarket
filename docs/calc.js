// Shared math for Soi Cổ Phiếu 360° — used by the Worker and copied into the site.
// All dates are handled as UTC calendar days ("YYYY-MM-DD").

const pad = n => String(n).padStart(2, "0");
export function parseISO(s) { const [y, m, d] = String(s).split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); }
export function isoDate(d) { return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }
export function addMonth(d) {
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, day = d.getUTCDate();
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(day, last)));
}
// weekdays in (a, b]; US market holidays are not removed
export function tradingDaysBetween(a, b) {
  let n = 0; const d = new Date(a.getTime());
  while (d < b) { d.setUTCDate(d.getUTCDate() + 1); const w = d.getUTCDay(); if (w !== 0 && w !== 6) n++; }
  return n;
}
export function futureTradingDates(from, count) {
  const out = []; const d = new Date(from.getTime());
  while (out.length < count) { d.setUTCDate(d.getUTCDate() + 1); const w = d.getUTCDay(); if (w !== 0 && w !== 6) out.push(new Date(d.getTime())); }
  return out;
}

export function quantStats(dates, c) {
  const n = c.length; if (n < 2) return null;
  const last = c[n - 1];
  const lr = []; for (let i = 1; i < n; i++) lr.push(Math.log(c[i] / c[i - 1]));
  const win = lr.slice(-60); const mean = win.reduce((a, b) => a + b, 0) / win.length;
  const sd = Math.sqrt(win.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, win.length - 1));
  const sma = k => n >= k ? c.slice(-k).reduce((a, b) => a + b, 0) / k : null;
  const ret = k => n > k ? last / c[n - 1 - k] - 1 : null;
  const yr = c.slice(-252);
  let peak = yr[0], mdd = 0; for (const v of yr) { peak = Math.max(peak, v); mdd = Math.min(mdd, v / peak - 1); }
  return { n, last, lastDate: dates[n - 1], firstDate: dates[0], sdDaily: sd, annVol: sd * Math.sqrt(252),
    sma20: sma(20), sma50: sma(50), sma200: sma(200), r1m: ret(21), r3m: ret(63), r6m: ret(126), r1y: ret(252),
    hi: Math.max(...yr), lo: Math.min(...yr), mdd1y: mdd };
}

export const Z = { 50: 0.6745, 80: 1.2816, 95: 1.96 };
export function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}
const num = v => { if (v == null || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

// Log-normal cone. The centre drifts toward the probability-weighted scenario return,
// clamped to ±1 standard deviation of the horizon so the AI view cannot dominate.
export function forecast(P, sdDaily, T, scenarios) {
  let mu = 0, wsum = 0, sc = [];
  if (Array.isArray(scenarios)) {
    for (const s of scenarios) { const p = num(s?.prob), r = num(s?.return_pct); if (p != null && r != null && p > 0 && r > -95) { sc.push({ name: String(s.name || ""), drivers: String(s.drivers || ""), p, r }); wsum += p; } }
    if (wsum > 0) sc = sc.map(s => ({ ...s, p: s.p / wsum }));
    for (const s of sc) mu += s.p * Math.log(1 + s.r / 100);
  }
  const hs = sdDaily * Math.sqrt(T);
  const muRaw = mu; mu = Math.max(-hs, Math.min(hs, mu));
  const median = P * Math.exp(mu);
  const band = z => [median * Math.exp(-z * hs), median * Math.exp(z * hs)];
  return { mu, muRaw, clamped: Math.abs(muRaw - mu) > 1e-9, median, b50: band(Z[50]), b80: band(Z[80]), b95: band(Z[95]), probUp: 1 - normCdf(-mu / hs), scenarios: sc };
}
export function forecastPath(P, mu, sdDaily, T, k) {
  const m = P * Math.exp(mu * k / T), s = sdDaily * Math.sqrt(k);
  return { m, l50: m * Math.exp(-Z[50] * s), h50: m * Math.exp(Z[50] * s), l80: m * Math.exp(-Z[80] * s), h80: m * Math.exp(Z[80] * s), l95: m * Math.exp(-Z[95] * s), h95: m * Math.exp(Z[95] * s) };
}

export const CRIT = [
  ["business", "Mô hình KD & lợi thế", 15], ["growth", "Tiềm năng tăng trưởng", 15], ["financial", "Sức khoẻ tài chính", 15], ["valuation", "Định giá hấp dẫn", 15],
  ["b2b", "Mạng lưới B2B", 10], ["b2c", "Thương hiệu & B2C", 10], ["management", "Ban lãnh đạo", 10], ["risk", "Mức an toàn (rủi ro thấp)", 10]];
export function totalScore(scores) {
  let s = 0, w = 0;
  for (const [k, , wt] of CRIT) { const v = num(scores?.[k]); if (v != null) { s += Math.max(0, Math.min(10, v)) / 10 * wt; w += wt; } }
  return w ? Math.round(s / w * 100) : null;
}
export function verdictOf(total, mu) {
  if (total == null) return { cls: "warn", ic: "⚖️", t: "Chưa đủ dữ liệu để kết luận", d: "AI không chấm đủ tiêu chí." };
  if (total >= 70 && mu >= 0) return { cls: "good", ic: "✅", t: "Tích cực — đáng cân nhắc mua", d: "Doanh nghiệp chấm điểm cao và kịch bản 1 tháng nghiêng về tăng. Vẫn nên chia nhỏ lệnh và đặt mức cắt lỗ." };
  if (total >= 70) return { cls: "warn", ic: "⏳", t: "Doanh nghiệp tốt — chờ giá đẹp hơn", d: "Nền tảng tốt nhưng kịch bản 1 tháng nghiêng về giảm; có thể theo dõi để mua ở vùng thấp hơn." };
  if (total >= 50) return { cls: "warn", ic: "👀", t: "Trung lập — theo dõi thêm", d: "Có điểm mạnh nhưng cũng có điểm yếu đáng kể. Chờ thêm tín hiệu (kết quả kinh doanh, định giá rẻ hơn)." };
  return { cls: "bad", ic: "⛔", t: "Thận trọng — chưa nên mua", d: "Điểm tổng thấp: rủi ro hoặc định giá chưa tương xứng với chất lượng doanh nghiệp." };
}
