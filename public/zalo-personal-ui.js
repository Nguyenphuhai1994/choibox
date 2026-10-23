export function zaloPersonalUI({api,show,modal,esc,reload,toast}){
 let flow=null,timer=null,generation=0,starting=false;
 function clear(){clearTimeout(timer);timer=null;const id=flow;flow=null;return id;}
 modal.addEventListener('close',()=>{generation++;const id=clear();if(id)api('/zalo-personal/flows/'+id,'DELETE').then(async r=>{if(r.connected){await reload(true);toast('Tài khoản Zalo đã được kết nối trước khi đóng cửa sổ. Bạn có thể tạm dừng hoặc xoá kênh tại Kênh kết nối.');}}).catch(()=>{});});
 async function start(channelId){
  if(starting)return;starting=true;
  const previous=clear(),version=++generation;
  show('Kết nối Zalo cá nhân','<p role="status">Đang tạo mã QR…</p><p class="help">Mở ứng dụng Zalo trên điện thoại để quét mã. Sau đó xác nhận đăng nhập trên điện thoại.</p>');
  try{
   if(previous)await api('/zalo-personal/flows/'+previous,'DELETE').catch(()=>{});
   const result=await api('/zalo-personal/start','POST',{channel_id:channelId});
   if(version!==generation||!modal.open){api('/zalo-personal/flows/'+result.id,'DELETE').catch(()=>{});return;}
   flow=result.id;
   let lastView='';
   async function poll(){
    if(version!==generation||!modal.open)return;
    try{
     const r=await api('/zalo-personal/flows/'+result.id);if(version!==generation||!modal.open)return;
     const failed=['failed','expired','declined','cancelled'].includes(r.status);
     if(r.status==='connected'){
      clear();await reload(true);modal.close();toast('Đã lưu kênh Zalo '+r.name+'. Trạng thái nhận tin hiển thị ở Kênh kết nối.');return;
     }
     const status=r.status==='qr'?'Mở Zalo → Quét mã QR, rồi xác nhận đăng nhập.':r.status==='scanned'?'Đã quét mã'+(r.name?' bằng tài khoản '+r.name:'')+'. Hãy xác nhận trên điện thoại.':r.status==='connecting'?'Đã xác nhận. Đang lưu kết nối…':failed?r.error||'Phiên đã kết thúc.':'Đang tạo mã QR…';
     const signature=JSON.stringify([r.status,r.qr,r.name,r.error]);
     if(signature!==lastView){lastView=signature;show('Kết nối Zalo cá nhân',`<div class="zalo-qr"><p role="${failed?'alert':'status'}" class="${failed?'error':''}">${esc(status)}</p>${r.status==='qr'&&r.qr?`<img src="${esc(r.qr)}" width="280" height="280" alt="Mã QR đăng nhập Zalo cá nhân"><small class="muted">Mã có hiệu lực khoảng 100 giây.</small>`:''}${failed?`<button class="primary" data-action="connect-zalo-personal" ${channelId?`data-zalo-reconnect="${Number(channelId)}"`:''}>Tạo mã QR mới</button>`:''}<p class="help">Tài khoản được lưu mã hoá trên máy chủ Choibox của bạn. Nhân viên được cấp quyền sẽ dùng chung kênh này.</p><p class="help">Kết nối này dùng thư viện không chính thức, có rủi ro bị Zalo hạn chế tài khoản. Không mở Zalo Web cùng tài khoản khi đang dùng Choibox.</p><button data-action="close-modal">${failed?'Đóng':'Huỷ kết nối'}</button></div>`);}
     if(!failed)timer=setTimeout(poll,1500);
    }catch(e){if(version===generation&&modal.open)show('Chưa kết nối được Zalo',`<p class="error" role="alert">${esc(e.message)}</p><button data-action="connect-zalo-personal" ${channelId?`data-zalo-reconnect="${Number(channelId)}"`:''}>Tạo mã QR mới</button>`);}
   }
   await poll();
  }catch(e){if(version===generation&&modal.open)show('Chưa kết nối được Zalo',`<p class="error" role="alert">${esc(e.message)}</p><button data-action="connect-zalo-personal">Thử lại</button>`);}
  finally{starting=false;}
 }
 return {start};
}
