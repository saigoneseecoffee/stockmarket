# Soi Cổ Phiếu 360° — cổ phiếu Mỹ

Bạn nhập mã cổ phiếu Mỹ, ngày kiểm tra và mã PIN. Trang sẽ:
- lấy giá thật từ Yahoo Finance (nếu Yahoo lỗi thì dùng Stooq);
- lấy số liệu tài chính chính thức và các hồ sơ đã nộp từ **SEC EDGAR**;
- để **Claude tìm trên web** tin tức, kết quả quý, giá mục tiêu của giới phân tích, khách hàng và nhà cung cấp lớn;
- chấm điểm 8 tiêu chí, đưa ra kết luận và vùng giá dự kiến sau 1 tháng;
- ghi mỗi lần soi vào **Google Sheet**. Sau ngày mục tiêu, giá thực tế được điền tự động để chấm xem dự báo đúng hay sai.

```
docs/          → GitHub Pages (trang web công khai, KHÔNG chứa bí mật nào)
worker/        → Cloudflare Worker (giữ khoá API Claude, PIN, link Sheet)
apps-script/   → Google Apps Script (ghi và đọc Google Sheet)
```

Luồng chạy: Trang GitHub → Worker → (Yahoo, SEC, Claude API + web search, Google Sheet).
Trang web chỉ biết link Worker. Mọi khoá bí mật nằm trong Worker.

---

## Bước 1 — Google Sheet (5 phút)
1. Tạo một Google Sheet mới, đặt tên tuỳ ý (VD: "Soi Cổ Phiếu – Lịch sử").
2. Vào **Extensions → Apps Script**, xoá code mẫu, dán toàn bộ `apps-script/Code.gs` vào rồi Save.
3. Vào **Project Settings → Script properties → Add property**: tên `SECRET`, giá trị là một chuỗi ngẫu nhiên dài khoảng 40 ký tự. Ghi lại chuỗi này, sẽ dùng ở bước 2.
4. Vào **Deploy → New deployment → Web app**. Chọn **Execute as: Me**, **Who has access: Anyone**, rồi bấm Deploy và cấp quyền.
5. Copy link `https://script.google.com/macros/s/…/exec`. Link này chỉ dán vào Worker, **không** dán vào trang web.

Sheet sẽ tự tạo 2 tab: `LichSu` (mỗi lần soi một dòng) và `BaoCao` (bản báo cáo đầy đủ để mở lại sau).

## Bước 2 — Cloudflare Worker (10 phút)
1. Lấy khoá API Claude tại **console.anthropic.com → API Keys**. Nên đặt giới hạn chi tiêu hằng tháng trong mục Billing.
2. Mở `worker/wrangler.toml` và sửa:
   - `ALLOWED_ORIGIN`: link GitHub Pages của bạn (VD: `https://saigoneseecoffee.github.io`).
   - `SEC_USER_AGENT`: thay bằng email thật của bạn. SEC chặn request không có email liên hệ.
   - `MODEL`: để `claude-sonnet-5-5` cho rẻ, hoặc đổi sang `claude-opus-5-5` nếu muốn phân tích sâu hơn (đắt hơn).
3. Trong thư mục `worker/`, chạy (cần Node.js):
   ```bash
   cd worker
   npx wrangler login
   npx wrangler kv namespace create RL       # dán id vào wrangler.toml, bỏ dấu # 3 dòng cuối
   npx wrangler secret put ANTHROPIC_API_KEY
   npx wrangler secret put APP_PIN           # mã PIN để mở trang
   npx wrangler secret put SHEET_URL         # link /exec ở bước 1
   npx wrangler secret put SHEET_SECRET      # chuỗi SECRET ở bước 1
   npx wrangler deploy
   ```
4. Copy link Worker (VD: `https://soicophieu.<tên-bạn>.workers.dev`). Mở link đó trên trình duyệt phải thấy `{"ok":true,...}`.

## Bước 3 — GitHub Pages (3 phút)
1. Mở `docs/index.html`, tìm dòng `const API_BASE = "https://soicophieu.YOUR-SUBDOMAIN.workers.dev";` rồi thay bằng link Worker ở bước 2 (sửa ngay trên GitHub bằng nút ✏️ cũng được).
2. Vào **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `/docs`** rồi bấm Save.
3. Đợi khoảng 1 phút, mở `https://saigoneseecoffee.github.io/stockmarket/`, nhập PIN và thử với mã `AAPL`.

> Muốn dùng tên miền riêng (VD: `stock.saigonesee.com`): làm thêm bước Custom domain trong Pages, rồi thêm tên miền đó vào `ALLOWED_ORIGIN`.

---

## Bảo mật
- Khoá API, PIN, link Sheet và SECRET chỉ nằm trong Worker secrets. Trên GitHub không có bí mật nào.
- Worker chỉ nhận request từ trang của bạn (`ALLOWED_ORIGIN`). Một IP nhập sai PIN 8 lần trong 1 giờ sẽ bị khoá. Mỗi ngày tối đa `DAILY_LIMIT` lượt phân tích (mặc định 30). Hai tính năng khoá và giới hạn lượt cần bật KV `RL`.
- Apps Script từ chối mọi request không có đúng `SECRET`. Dữ liệu được làm sạch để không ai chèn được công thức vào Sheet.
- Nếu lộ PIN: chạy `npx wrangler secret put APP_PIN` để đổi.

## Chi phí ước tính
Mỗi lần soi gồm 1 lần gọi Claude API (khoảng 8 lượt tìm kiếm web cộng tokens).
- Tìm kiếm web: $10 cho 1.000 lượt, tức khoảng $0,08 mỗi lần soi.
- Tokens: tuỳ model. Xem bảng giá trên docs.claude.com.

Yahoo, Stooq, SEC, Cloudflare (gói miễn phí) và Google Sheet đều miễn phí.

## Giới hạn
- Giá Yahoo có thể trễ khoảng 15 phút. Số phiên giao dịch không trừ ngày lễ Mỹ.
- Vùng giá 1 tháng là mô hình thống kê (log-normal, biến động 60 phiên, dịch theo 3 kịch bản của Claude). Đây không phải lời hứa.
- Nếu chọn ngày kiểm tra trong quá khứ, Claude được dặn chỉ dùng tin trước ngày đó, nhưng không đảm bảo tuyệt đối.
- Mọi thứ chỉ để tham khảo, không phải lời khuyên đầu tư.

## Kiểm tra code
```bash
cd worker && node test.mjs   # 16 bài test Worker với dữ liệu giả lập
```

## Giấy phép
MIT — xem `LICENSE`.
