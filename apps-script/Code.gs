/**
 * Soi Cổ Phiếu 360° — Google Sheet backend
 * Chỉ Cloudflare Worker gọi vào đây (kèm SECRET). Trang web không biết link này.
 *
 * Cài đặt: Extensions → Apps Script → dán file này → Project Settings → Script properties:
 *   SECRET = một chuỗi dài ngẫu nhiên (giống SHEET_SECRET trong Worker)
 * Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone → copy URL.
 */
const SHEET_NAME = 'LichSu';
const REPORT_SHEET = 'BaoCao';
const HEADERS = ['id','Thời gian','Mã','Công ty','Ngày kiểm tra','Ngày mục tiêu','Giá lúc soi','Dự kiến (trung vị)','Vùng 80% thấp','Vùng 80% cao','Xác suất tăng (%)','Điểm','Kết luận','Độ tin cậy','Model','Giá thực tế','Ngày giá thực tế','Trúng vùng 80%?','Lệch so với trung vị (%)'];
const KEYS = ['id','createdAt','ticker','name','checkDate','targetDate','price','median','lo80','hi80','probUp','score','verdict','confidence','model','actual','actualDate','inBand','errPct'];

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return out({ error: 'bad_json' }); }
  const secret = PropertiesService.getScriptProperties().getProperty('SECRET');
  if (!secret || body.secret !== secret) return out({ error: 'unauthorized' });
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (body.action === 'append') return out(append(body.row || {}, String(body.report || '')));
    if (body.action === 'list') return out({ rows: list() });
    if (body.action === 'get') return out(getReport(String(body.id || '')));
    if (body.action === 'setActual') return out(setActual(String(body.id || ''), Number(body.actual), String(body.actualDate || '')));
    return out({ error: 'bad_action' });
  } finally { lock.releaseLock(); }
}
function doGet() { return out({ ok: true }); }

function sheet(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); sh.appendRow(headers); sh.setFrozenRows(1); sh.getRange(1, 1, 1, headers.length).setFontWeight('bold'); }
  return sh;
}
function clean(v, max) { return String(v == null ? '' : v).replace(/^[=+\-@]/, "'$&").slice(0, max || 200); }
function cleanNum(v) { const n = Number(v); return isFinite(n) ? n : ''; }

function append(row, report) {
  if (!/^[A-Z.\-]{1,9}-[a-z0-9]{6,12}$/.test(String(row.id))) return { error: 'bad_id' };
  const sh = sheet(SHEET_NAME, HEADERS);
  sh.appendRow([row.id, clean(row.createdAt, 40), clean(row.ticker, 10), clean(row.name, 120), clean(row.checkDate, 10), clean(row.targetDate, 10),
    cleanNum(row.price), cleanNum(row.median), cleanNum(row.lo80), cleanNum(row.hi80), cleanNum(row.probUp), cleanNum(row.score),
    clean(row.verdict, 80), clean(row.confidence, 20), clean(row.model, 40), '', '', '', '']);
  if (report && report.length < 49000) sheet(REPORT_SHEET, ['id', 'report']).appendRow([row.id, report]);
  return { ok: true };
}
function list() {
  const sh = sheet(SHEET_NAME, HEADERS);
  const n = sh.getLastRow(); if (n < 2) return [];
  const start = Math.max(2, n - 199);
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const vals = sh.getRange(start, 1, n - start + 1, KEYS.length).getValues();
  return vals.reverse().map(r => { const o = {}; KEYS.forEach((k, i) => { o[k] = r[i] instanceof Date ? Utilities.formatDate(r[i], tz, 'yyyy-MM-dd') : r[i]; }); return o; });
}
function getReport(id) {
  const sh = sheet(REPORT_SHEET, ['id', 'report']);
  const f = sh.getRange('A:A').createTextFinder(id).matchEntireCell(true).findNext();
  return f ? { report: sh.getRange(f.getRow(), 2).getValue() } : { error: 'not_found' };
}
function setActual(id, actual, actualDate) {
  if (!(actual > 0)) return { error: 'bad_value' };
  const sh = sheet(SHEET_NAME, HEADERS);
  const f = sh.getRange('A:A').createTextFinder(id).matchEntireCell(true).findNext();
  if (!f) return { error: 'not_found' };
  const r = f.getRow();
  const v = sh.getRange(r, 1, 1, KEYS.length).getValues()[0];
  const median = Number(v[7]), lo = Number(v[8]), hi = Number(v[9]);
  sh.getRange(r, 16, 1, 4).setValues([[actual, actualDate, (actual >= lo && actual <= hi) ? 'Trúng' : 'Trượt', median ? Math.round((actual / median - 1) * 1000) / 10 : '']]);
  return { ok: true };
}
function out(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
