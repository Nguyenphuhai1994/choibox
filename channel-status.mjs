const tenMinutes=10*60*1000;
export function channelStatus(channel,{runtime,now=Date.now()}={}){
 const checked=channel.last_checked||null,last=channel.last_event||null;
 const status=(state,label,detail)=>({state,label,detail,checked_at:checked,last_event:last});
 if(channel.mode==='demo')return status('demo','Dữ liệu mẫu','Kênh dữ liệu mẫu để xem giao diện.');
 if(!channel.enabled)return status('paused','Tạm dừng','Kênh đang được tạm dừng bởi quản trị viên.');
 if(['facebook_personal','zalo_personal'].includes(channel.provider)){
  if(runtime){
   if(channel.provider==='facebook_personal'){
    if(runtime.connected&&runtime.encrypted)return status('connected','Đang hoạt động','Messenger thường và Messenger mã hoá đều đang kết nối.');
    if(runtime.connected||runtime.encrypted)return status('partial','Kết nối một phần',runtime.encrypted?'Messenger mã hoá đang hoạt động; kết nối thường đang ngắt.':'Messenger thường đang hoạt động; tin mã hoá chưa kết nối.');
   }else if(runtime.connected)return status('connected','Đang hoạt động','Đang kết nối tài khoản Zalo để nhận tin nhắn.');
   if(runtime.connecting)return status('connecting','Đang kết nối','Đang khôi phục kết nối với nền tảng.');
  }
  return status('disconnected','Đã ngắt kết nối','Chưa có kết nối nhận tin. Quản trị viên có thể kiểm tra hoặc đăng nhập lại.');
 }
 if(!channel.secret)return status('unverified','Chưa kết nối','Chưa có thông tin kết nối kênh.');
 if(!channel.verified)return status(checked?'disconnected':'unverified',checked?'Cần kết nối lại':'Chưa kiểm tra','Bấm để kiểm tra quyền truy cập của kênh.');
 const age=now-Date.parse(checked||'');
 if(!Number.isFinite(age)||age>tenMinutes)return status('unverified','Cần kiểm tra','Kết quả kiểm tra kết nối đã cũ. Bấm để kiểm tra lại.');
 return status('connected','Đã kết nối','Quyền truy cập kênh còn hợp lệ. Thời gian nhận tin gần nhất hiển thị bên dưới.');
}
