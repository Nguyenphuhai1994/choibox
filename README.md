# Choibox 1.12.0 — mã nguồn máy chủ

Gói mã nguồn dành cho VPS Linux, không chứa dữ liệu chạy thật, khoá riêng hoặc gói ứng dụng Mac/Windows. Chưa có bộ cài VPS một lệnh hay cấu hình HTTPS tự động.

## Đưa lên GitHub
Tạo repository riêng tư. Tải nội dung bên trong thư mục này lên gốc repository. package.json, package-lock.json và server.mjs phải ở gốc, không nằm trong thư mục con. Không chỉ tải file ZIP lên.

Giữ .gitignore và kiểm tra danh sách trước khi commit. Không đưa thư mục dữ liệu, secret.key, token, cookie, .env, bản sao lưu hay khoá SSH lên GitHub. .gitignore bảo vệ thao tác Git; khi kéo thả bằng trình duyệt, vẫn phải kiểm tra danh sách tải lên.

## Chạy trên VPS
Yêu cầu Node.js hỗ trợ node:sqlite (tối thiểu 22.13 theo package.json), npm và HTTPS cố định. Cần thiết lập reverse proxy HTTPS, PUBLIC_URL và dịch vụ chạy Choibox liên tục. Repository riêng tư cần quyền tải mã trên VPS.

Cài thư viện sản xuất bằng npm ci --omit=dev --ignore-scripts, rồi chạy npm start sau khi cấu hình các biến môi trường riêng ngoài repository:
- DATA_DIR: thư mục dữ liệu bền vững ngoài mã nguồn, giữ qua các lần cập nhật.
- HOST: mặc định 127.0.0.1 khi reverse proxy cùng VPS.
- PORT: mặc định 4317.
- PUBLIC_URL: địa chỉ HTTPS của máy chủ này.
- SETUP_TOKEN: khoá khởi tạo riêng cho máy chủ mới; không commit giá trị thật.

Cấu hình Meta chung/kích hoạt là cấu hình riêng, không đóng gói trong repository. Chuyển dữ liệu cũ phải giữ SQLite, secret.key và cấu hình kết nối riêng. Không tạo khoá mới thay khoá đang dùng nếu muốn đọc token cũ.

## Lưu trữ
Tin nhắn chữ, khách hàng, thẻ và đơn hàng lưu trong SQLite. Tệp mới tải khi xem, lưu trong DATA_DIR/media-cache; mặc định 7 ngày và 2 GB, chỉnh tại Máy chủ & truy cập. Tệp có đường dẫn hết hạn có thể không tải lại được. Giới hạn lưu tạm không giới hạn toàn ổ đĩa hay bản sao lưu.

## Phạm vi
Có mã máy chủ, giao diện và kiểm thử. cloudflare/deploy chỉ gồm mã phụ trợ cần cho kiểm thử, không chứa cấu hình triển khai cũ. Không có tài nguyên/binary đóng gói desktop; các lệnh build Mac/Windows không dùng trong gói VPS. Chưa bao gồm scripts tự cài, cập nhật và khôi phục VPS.

Được phát triển bởi [Choiagency](https://choiagency.top).
