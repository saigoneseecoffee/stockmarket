# Soi Cổ Phiếu 360° — cổ phiếu Mỹ (bản miễn phí)

Bạn nhập mã cổ phiếu Mỹ, ngày kiểm tra và PIN. Trang sẽ:
- lấy **giá thật** từ Yahoo Finance (lỗi thì dùng Stooq) và **số liệu tài chính chính thức + hồ sơ** từ SEC EDGAR;
- tính **vùng giá sau 1 tháng** (log-normal theo biến động 60 phiên), vẽ biểu đồ, ghi vào **Google Sheet**;
- soạn sẵn **câu hỏi cho Claude chat** chứa toàn bộ số liệu. Bạn copy, dán vào Claude (dùng gói Claude đang có, không tốn thêm), rồi dán câu trả lời JSON lại vào trang. Trang dựng báo cáo đầy đủ (B2B, B2C, tin tức, định giá, rủi ro, chấm điểm, kết luận), dịch vùng giá theo 3 kịch bản của Claude và cập nhật dòng đó trong Sheet;
- sau ngày mục tiêu, tự điền giá thực tế để chấm dự báo đúng hay sai.

```
docs/          → GitHub Pages (trang web công khai, KHÔNG chứa bí mật nào)
worker/        → Cloudflare Worker (giữ PIN, link Sheet, SECRET; lấy giá + SEC)
apps-script/   → Google Apps Script (ghi và đọc Google Sheet)
```

Không dùng Claude API, nên không cần khoá API và không mất phí theo lượt. Cloudflare (gói miễn phí), Yahoo, SEC và Google Sheet đều miễn phí.

## Bước 1 — Google Sheet (5 phút)
1. Tạo một Google Sheet mới, đặt tên tuỳ ý (VD: "Soi Cổ Phiếu – Lịch sử").
2. Vào **Extensions → Apps Script**, xoá code mẫu, dán toàn bộ `apps-script/Code.gs` vào rồi Save.
3. Vào **Project Settings → Script properties → Add property**: tên `SECRET`, giá trị là một chuỗi ngẫu nhiên dài khoảng 40 ký tự. Ghi lại chuỗi này, sẽ dùng ở bước 2.
4. Vào **Deploy → New deployment → Web app**. Chọn **Execute as: Me**, **Who has access: Anyone**, rồi bấm Deploy và cấp quyền.
5. Copy link `https://script.google.com/macros/s/…/exec`. Link này chỉ dán vào Worker, **không** dán vào trang web.

Sheet sẽ tự tạo 2 tab: `LichSu` (mỗi lần soi một dòng) và `BaoCao` (bản báo cáo đầy đủ để mở lại sau).

## Bước 2 — Cloudflare Worker (10 phút)
1. Mở `worker/wrangler.toml` và sửa:
   - `ALLOWED_ORIGIN`: link GitHub Pages của bạn (VD: `https://saigoneseecoffee.github.io`).
   - `SEC_USER_AGENT`: thay bằng email thật của bạn. SEC chặn request không có email liên hệ.
2. Trong thư mục `worker/`, chạy (cần Node.js):
   ```bash
   cd worker
   npx wrangler login
   npx wrangler kv namespace create RL       # dán id vào wrangler.toml, bỏ dấu # 3 dòng cuối
   npx wrangler secret put APP_PIN           # mã PIN để mở trang
   npx wrangler secret put SHEET_URL         # link /exec ở bước 1
   npx wrangler secret put SHEET_SECRET      # chuỗi SECRET ở bước 1
   npx wrangler deploy
   ```
3. Copy link Worker (VD: `https://soicophieu.<tên-bạn>.workers.dev`). Mở link đó trên trình duyệt phải thấy `{"ok":true,...}`.

## Bước 3 — GitHub Pages (3 phút)
1. Mở `docs/index.html`, tìm dòng `const API_BASE = "https://soicophieu.YOUR-SUBDOMAIN.workers.dev";` rồi thay bằng link Worker ở bước 2 (sửa ngay trên GitHub bằng nút ✏️ cũng được).
2. Vào **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `/docs`** rồi bấm Save.
3. Đợi khoảng 1 phút, mở `https://saigoneseecoffee.github.io/stockmarket/`, nhập PIN và thử với mã `AAPL`.

> Muốn dùng tên miền riêng (VD: `stock.saigonesee.com`): làm thêm bước Custom domain trong Pages, rồi thêm tên miền đó vào `ALLOWED_ORIGIN`.

---

## Bảo mật
- PIN, link Sheet và SECRET chỉ nằm trong Worker secrets. Trên GitHub không có bí mật nào.
- Worker chỉ nhận request từ trang của bạn (`ALLOWED_ORIGIN`). Một IP nhập sai PIN 8 lần trong 1 giờ sẽ bị khoá. Mỗi ngày tối đa `DAILY_LIMIT` lượt lấy dữ liệu (mặc định 100). Hai tính năng khoá và giới hạn lượt cần bật KV `RL`.
- Apps Script từ chối mọi request không có đúng `SECRET`. Dữ liệu được làm sạch để không ai chèn được công thức vào Sheet.
- Nếu lộ PIN: chạy `npx wrangler secret put APP_PIN` để đổi.

## Giới hạn
- Giá Yahoo có thể trễ khoảng 15 phút. Số phiên giao dịch không trừ ngày lễ Mỹ.
- Vùng giá 1 tháng là mô hình thống kê (log-normal, biến động 60 phiên; khi có phân tích Claude thì tâm dịch theo 3 kịch bản, giới hạn ±1 độ lệch chuẩn). Đây không phải lời hứa.
- Phân tích chữ phụ thuộc vào những gì Claude chat tìm được; hãy mở link trong mục Nguồn để đối chiếu.
- Nếu chọn ngày kiểm tra trong quá khứ, câu hỏi dặn Claude chỉ dùng tin trước ngày đó, nhưng không đảm bảo tuyệt đối.
- Mọi thứ chỉ để tham khảo, không phải lời khuyên đầu tư.

## Kiểm tra code
```bash
cd worker && node test.mjs   # 21 bài test Worker với dữ liệu giả lập
```

## Giấy phép
MIT — xem `LICENSE`.
