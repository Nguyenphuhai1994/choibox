# Choibox 1.15.0 — mã nguồn máy chủ

Mã nguồn Choibox cho VPS Linux: Facebook Page, Facebook cá nhân, Zalo cá nhân/OA, hộp thư chung, phân quyền, thẻ khách hàng và đơn hàng.

## Thay đổi 1.15.0
- Sản phẩm: nhập mới từ Excel .xlsx hoặc CSV UTF-8, tối đa 500 dòng / 2 MB; tải mẫu, xem trước và kiểm tra từng dòng. Mã trùng (trong file hoặc danh mục), số tồn/giá sai sẽ chặn cả lô. Nhập lại cùng mã lần nhập không tạo trùng. Không cập nhật đè tồn của sản phẩm đã có.
- Mẫu gồm: Mã sản phẩm, Tên sản phẩm, Nội dung, Đơn giá, Tồn kho, Trạng thái (Đang bán/Ngừng bán hoặc 1/0). Sheet đầu tiên, dữ liệu giá trị, không dùng công thức. Ảnh bổ sung riêng sau khi nhập.
- Xuất sản phẩm Excel/CSV theo tìm kiếm/bộ lọc hiện tại, không kèm ảnh. Lọc đang bán/còn hàng/sắp hết/hết hàng/ngừng bán, khoảng giá và ngưỡng sắp hết.
- Đơn hàng: lọc Hôm nay, Hôm qua, Tuần này (thứ Hai), Tháng này hoặc ngày tuỳ chọn tối đa 366 ngày; kết hợp kênh và trạng thái. Xuất Excel/CSV đúng danh sách lọc, tối đa 10.000 đơn/lần; file bao gồm ngày tạo, khách, sản phẩm, tổng, phí, giảm giá, trạng thái và kênh.
- Tổng quan: tin nhận/gửi, bình luận, ghi chú, hội thoại hoạt động, đang mở/chưa xử lý, đang xử lý, đã xử lý, chờ phản hồi, chưa phân công; đơn mới/xác nhận/đang giao/hoàn tất/huỷ và giá trị đơn. Dữ liệu theo kênh thật được cấp quyền, không tính kênh mẫu.
- Ngày báo cáo/lọc đơn dùng giờ Việt Nam (UTC+7), bao gồm cả ngày kết thúc. Đơn hàng theo ngày tạo; trạng thái là trạng thái hiện tại, không phải ảnh chụp trạng thái cuối ngày trong quá khứ. Hội thoại tính khi có tin trong kỳ; chờ phản hồi = tin cuối của khách và chưa đóng. Hoàn tất do người dùng đánh dấu, chưa tích hợp xác nhận giao hàng tự động.
- SVG icon cục bộ, danh sách hội thoại có trạng thái/người phụ trách, bộ lọc gọn; hồ sơ khách dạng bảng bên cạnh. Bố cục cho điện thoại, máy tính; không thay đổi dữ liệu/kết nối cũ.
- ExcelJS 4.4.0, uuid override 11.1.1; xử lý file trên máy chủ Choibox, không gửi file cho dịch vụ bên ngoài.
- Cần chạy npm ci --omit=dev --ignore-scripts sau cập nhật để có thư viện Excel; giữ DATA_DIR và cấu hình dịch vụ đang dùng.

## Sản phẩm và tồn kho (1.14.0)
- Quản trị viên thêm/sửa tên, SKU, ảnh, nội dung, đơn giá, số tồn hiện còn và trạng thái đang/ngừng bán ở mục Sản phẩm. Nhân viên xem danh mục và chọn sản phẩm khi tạo đơn trong chat.
- Ảnh JPG/PNG/WebP chọn từ máy tối đa 10 MB được tối ưu xuống tối đa 512 KB. Ảnh danh mục lưu bền vững trong SQLite, không bị dọn như bộ nhớ đệm tệp chat.
- Mỗi đơn mới dùng mã sản phẩm và đơn giá từ danh mục, trừ tồn ngay khi lưu. Không đủ tồn ở bất kỳ dòng nào thì toàn bộ lần tạo đơn bị hủy, không trừ dở hàng khác.
- SQLite khóa giao dịch khi kiểm tra và trừ tồn để tránh bán vượt số lượng. Gửi lại cùng mã tạo đơn không trừ thêm lần nữa.
- Hủy đơn hoàn tồn đúng một lần; mở lại đơn đã hủy cần đủ tồn và sản phẩm đang bán. Các trạng thái xác nhận/giao/hoàn tất không trừ thêm.
- Đơn cũ từ trước 1.14.0 vẫn giữ nguyên, không tự trừ hay hoàn tồn vì chưa gắn mã sản phẩm. Đổi tên/giá sản phẩm không thay thông tin đã ghi trong đơn.
- Biểu mẫu sửa sản phẩm có phiên bản; nếu vừa có đơn trừ kho, bản sửa cũ sẽ bị chặn để tránh ghi đè tồn. Bấm Tải lại sản phẩm rồi nhập lại số tồn mong muốn.

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
Tin nhắn chữ, khách hàng, thẻ, đơn hàng, sản phẩm và ảnh danh mục lưu trong SQLite. Tệp tải khi xem và lưu tạm trong DATA_DIR/media-cache; mặc định 7 ngày và 2 GB, có thể đổi ở Máy chủ & truy cập. Đường dẫn hết hạn có thể không tải lại được.

Mật khẩu/OTP Facebook cá nhân không được lưu. Cookie được mã hoá bằng khoá của Choibox; khoá thiết bị Messenger nằm trong DATA_DIR/facebook-devices và chưa mã hoá riêng ở tầng SQLite. Bảo vệ quyền truy cập và ổ đĩa chứa DATA_DIR.

Không đưa data, cookie, secret.key, .env, token, cấu hình khách hàng hoặc khoá SSH lên GitHub. .gitignore hỗ trợ thao tác Git; vẫn kiểm tra danh sách khi tải bằng trình duyệt.

## Kiểm chứng và mã nguồn thư viện
94 kiểm thử Node và 6 kiểm thử Go đã qua trên macOS Intel. Đã kiểm tra đăng nhập, gửi/nhận văn bản, khôi phục phiên, nhận/giải mã/phóng lớn ảnh JPEG và phát video MP4 thật. Phần sản phẩm đã kiểm tra thêm ảnh, lên đơn đủ tồn, chặn vượt tồn, hủy đơn hoàn tồn và giao diện 390 px. Các kiểm thử tồn kho bao gồm tạo đồng thời từ hai kết nối, ghi lại yêu cầu, nhiều sản phẩm bị lỗi, sửa tồn bị cũ và nâng cấp đơn hàng cũ. Binary Linux đã biên dịch nhưng chưa chạy thực tế trên VPS trong lần kiểm tra này.

Connector có mã nguồn, go.mod/go.sum, bảng phụ thuộc, NOTICE và giấy phép AGPL-3.0-or-later trong connectors/facebook-personal. SHA-256 kiểm tra tính toàn vẹn, không phải chứng nhận an toàn hay kiểm toán mã độc.

Gói này dành cho máy chủ; không kèm tài nguyên Electron/cloudflared để tự đóng gói ứng dụng desktop. Các gói macOS/Windows được cung cấp riêng.

Được phát triển bởi [Choiagency](https://choiagency.top).
