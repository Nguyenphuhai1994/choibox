# Facebook cá nhân trong Choibox

Lớp tích hợp, giao thức tiến trình và màn hình Choibox được viết riêng.
Không chạy Deplao, không dùng bộ cài hay máy chủ Deplao. Giao thức Messenger
dùng trực tiếp thư viện nguồn mở mautrix/meta, ghim commit trong go.mod/go.sum.
NOTICE.md và LICENSE giữ thông tin nguồn/giấy phép. Tách tiến trình giúp tách lỗi,
không phải một sandbox hệ điều hành hoặc bảo đảm loại trừ mã độc.

## Xây dựng từ nguồn

Cần Go 1.27.3 (hoặc bản tương thích go.mod). Không tải binary tự động khi chạy.
Tại thư mục Choibox:

    npm run build:facebook
    npm run build:facebook -- --targets=linux-amd64
    npm run build:facebook -- --targets=darwin-amd64,darwin-arm64,windows-amd64

Có thể đặt GO thành đường dẫn tuyệt đối của Go.
Bộ kết nối được kiểm tra SHA-256 với bin/manifest.json trước mỗi lần mở.
Hash phát hiện file thay đổi so với bản build, không chứng minh mã nguồn an toàn.
Không chỉnh tay manifest để bỏ qua sai lệch.

## Luồng hoạt động

Quản trị viên: Kênh kết nối → Thêm kênh → Facebook cá nhân.
Đăng nhập và xử lý mã/xác nhận trực tiếp. Không cần App Meta.
Khi đồng ý kết nối, Choibox đăng ký thiết bị Messenger để nhận tin mã hoá.
Chỉ quản trị viên tạo phiên; nhân viên vẫn dùng quyền kênh hiện có.
Không tích hợp Page/bình luận qua bộ kết nối này.

Phiên chỉ được lưu sau khi Facebook trả thông tin đúng tài khoản.
Cookie lưu trong secret được mã hoá AES-GCM của Choibox. Mật khẩu/mã OTP không lưu.
Khoá thiết bị Signal dùng SQLite trong DATA_DIR/facebook-devices/<mã ngẫu nhiên>/,
quyền thư mục 0700 và file theo umask 077 trên POSIX; Windows dùng quyền truy cập kế thừa của tài khoản chạy chương trình. Khoá thiết bị chưa mã hoá riêng ở tầng
SQLite; hãy dùng ổ đĩa/máy chủ được bảo vệ nếu cần mã hoá toàn bộ khi lưu trữ.
Không sao chép cookie/khoá từ bộ thử Deplao cũ sang bộ kết nối mới.

Worker không nhận biến môi trường chứa App Secret/API token của Choibox.
Log giao thức thư viện bị tắt; lỗi trả lên giao diện là mã đã giới hạn.
Không cung cấp RPC shell, chạy lệnh hoặc đọc đường dẫn tệp tuỳ ý.
Giao tiếp nội bộ dùng stdin/stdout; không mở cổng quản trị riêng.
Thư viện nền vẫn có quyền mạng và quyền của tài khoản hệ điều hành chạy Choibox.

## Phạm vi và kiểm chứng

Đã triển khai văn bản Messenger thường/mã hoá, khôi phục phiên, cấp quyền,
tạm dừng và xoá kênh, chống lặp theo mã tin và không tự gửi lại tin chưa xác nhận.
Gửi ra hiện hỗ trợ văn bản. Ảnh và video nhận mới được giải mã và tải vào bộ nhớ đệm khi xuất hiện trong vùng xem; xem ảnh lớn và phát video trực tiếp trong chat. Giới hạn 25 MiB/tệp; không khôi phục ảnh từ các thông báo đính kèm đã nhận ở bản cũ.
Trạng thái hiển thị riêng kết nối Messenger thường/mã hoá; kết nối một phần không hiển thị như đang hoạt động đầy đủ.
Không cam kết tải đủ lịch sử cũ hoặc khoảng thời gian tắt máy.

Kiểm thử giả lập chỉ xác nhận xử lý nội bộ. Phải kiểm thử bằng tài khoản thật
trước khi coi đăng nhập, gửi/nhận và khôi phục mã hoá là thành công.
Bản thử cũ của Deplao không phải bằng chứng vận hành của lớp mới này.
