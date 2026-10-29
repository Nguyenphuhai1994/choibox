# Choibox 1.13.1 — mã nguồn máy chủ

Mã nguồn Choibox cho VPS Linux: Facebook Page, Facebook cá nhân, Zalo cá nhân/OA, hộp thư chung, phân quyền, thẻ khách hàng và đơn hàng.

## Thay đổi 1.13.1
- Thêm kết nối Facebook cá nhân, đăng nhập trực tiếp; không chạy ứng dụng Deplao. Connector viết riêng, dùng thư viện mautrix/meta ghim phiên bản.
- Hiện trạng thái kênh: đang hoạt động, kết nối một phần, đang kết nối, đã ngắt, tạm dừng. Bấm trạng thái để kiểm tra lại. Với Page/OA, trạng thái xác nhận quyền truy cập, không chứng minh webhook đang nhận tin.
- Ảnh hiện trong chat và mở lớn khi bấm; video phát trực tiếp, có hỗ trợ tua HTTP Range.
- Nhận mới ảnh/video Facebook cá nhân được mã hoá, giải mã khi xem, giới hạn 25 MiB. Gửi qua Facebook cá nhân hiện hỗ trợ văn bản.
- Giữ các tính năng xem ảnh lớn, gom tin theo người gửi và giờ từ bản trước.

## Cài trên VPS
Cần Node.js >=22.13, npm, Git và địa chỉ HTTPS của máy chủ (Cloudflare Tunnel hoặc reverse proxy). Gói này không tự thiết lập tên miền hay dịch vụ systemd.

Bộ kết nối Linux x86_64 được kèm dạng nén. Lệnh chuẩn bị giải nén cục bộ và kiểm tra SHA-256 trước khi cài; không tải/chạy chương trình từ máy chủ Deplao. Không cần cài Go cho Linux x86_64. Các nền tảng khác cần biên dịch từ mã nguồn theo [hướng dẫn connector](connectors/facebook-personal/README.md).

    git clone https://github.com/Nguyenphuhai1994/choibox.git
    cd choibox
    npm ci --omit=dev --ignore-scripts
    npm run prepare:facebook

Cấu hình riêng bên ngoài repository:
- DATA_DIR: thư mục dữ liệu bền vững, ví dụ /var/lib/choibox hoặc thư mục đang dùng.
- HOST: 127.0.0.1 khi Tunnel/reverse proxy cùng VPS.
- PORT: 4317 hoặc cổng đã chọn.
- PUBLIC_URL: URL HTTPS thực tế.
- SETUP_TOKEN: khoá khởi tạo riêng cho máy chủ mới; không công khai.

Sau đó chạy npm start hoặc dịch vụ systemd đã cấu hình. npm start tự gọi bước chuẩn bị connector; nếu dịch vụ chạy node server.mjs trực tiếp, hãy chạy npm run prepare:facebook trước lần đầu và sau mỗi lần cập nhật.

## Cập nhật VPS đã cài
Ví dụ VPS của bạn dùng /root/choibox và dịch vụ tên choibox:

    export NVM_DIR="$HOME/.nvm"
    . "$NVM_DIR/nvm.sh"
    nvm use 22
    cd /root/choibox
    git pull --ff-only origin main &&
    npm ci --omit=dev --ignore-scripts &&
    npm run prepare:facebook &&
    systemctl restart choibox
    systemctl status choibox --no-pager

Giữ DATA_DIR, secret.key, SQLite, facebook-devices và cấu hình kết nối riêng. Không tạo khoá mã hoá mới thay khoá đang dùng. Sao lưu dữ liệu trước cập nhật; mã nguồn không chứa dữ liệu hay cấu hình đăng nhập của bạn.

## Kết nối Facebook
Facebook cá nhân: Kênh kết nối → Thêm kênh → Facebook cá nhân. Đây là kết nối không chính thức; không bảo đảm tránh xác minh/giới hạn tài khoản và không cam kết đồng bộ đủ lịch sử khi máy tắt. Kiểm thử bằng tài khoản thử trước khi sử dụng thực tế.

Facebook Page/bình luận vẫn dùng luồng Meta chính thức và các quyền cần thiết. Cấu hình Meta chung/kích hoạt là cấu hình riêng của người triển khai, không kèm trong repository.

## Dữ liệu và bảo mật
Tin nhắn chữ, khách hàng, thẻ, đơn hàng lưu trong SQLite. Tệp tải khi xem và lưu tạm trong DATA_DIR/media-cache; mặc định 7 ngày và 2 GB, có thể đổi ở Máy chủ & truy cập. Đường dẫn hết hạn có thể không tải lại được.

Mật khẩu/OTP Facebook cá nhân không được lưu. Cookie được mã hoá bằng khoá của Choibox; khoá thiết bị Messenger nằm trong DATA_DIR/facebook-devices và chưa mã hoá riêng ở tầng SQLite. Bảo vệ quyền truy cập và ổ đĩa chứa DATA_DIR.

Không đưa data, cookie, secret.key, .env, token, cấu hình khách hàng hoặc khoá SSH lên GitHub. .gitignore hỗ trợ thao tác Git; vẫn kiểm tra danh sách khi tải bằng trình duyệt.

## Kiểm chứng và mã nguồn thư viện
85 kiểm thử Node và 6 kiểm thử Go đã qua trên macOS Intel. Đã kiểm tra đăng nhập, gửi/nhận văn bản, khôi phục phiên, nhận/giải mã/phóng lớn ảnh JPEG và phát video MP4 thật. Binary Linux đã biên dịch nhưng chưa chạy thực tế trên VPS trong lần kiểm tra này.

Connector có mã nguồn, go.mod/go.sum, bảng phụ thuộc, NOTICE và giấy phép AGPL-3.0-or-later trong connectors/facebook-personal. SHA-256 kiểm tra tính toàn vẹn, không phải chứng nhận an toàn hay kiểm toán mã độc.

Gói này dành cho máy chủ; không kèm tài nguyên Electron/cloudflared để tự đóng gói ứng dụng desktop. Các gói macOS/Windows được cung cấp riêng.

Được phát triển bởi [Choiagency](https://choiagency.top).
