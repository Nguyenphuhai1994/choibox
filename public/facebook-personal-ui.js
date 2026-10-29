export function facebookPersonalUI({api,show,modal,esc,reload,toast}){
 let flow=null,version=0,busy=false,step=null;
 async function abandon(id){if(id)await api('/facebook-personal/flows/'+id,'DELETE').catch(()=>{});}
 modal.addEventListener('close',()=>{version++;const id=flow;flow=null;step=null;void abandon(id);});
 const buttons=()=>modal.querySelectorAll('[data-fb-personal-submit],[data-fb-personal-command]');
 function pending(value){busy=value;for(const b of buttons())b.disabled=value;}
 function render(result){
  if(result.status==='connected'){
   flow=null;step=null;void reload(true).then(()=>{modal.close();toast('Đã lưu tài khoản Facebook '+(result.name||'')+'. Xem trạng thái Messenger ở Kênh kết nối.');});return;
  }
  if(result.step)step=result.step;
  if(result.status==='cancelled'){show('Kết nối Facebook cá nhân','<p>Phiên đã đóng.</p><button data-action="connect-facebook-personal">Đăng nhập lại</button>');return;}
  const fields=step?.user_input?.fields||[];
  const supported=step?.type==='user_input'&&fields.length>0&&fields.every(f=>['username','password','2fa_code','token','select','text','email'].includes(f.type));
  let inputs='';
  if(supported)for(const f of fields){
   const label=f.id==='username'?'Tài khoản Facebook':f.id==='password'?'Mật khẩu Facebook':f.name||f.id;
   const ident='fbp-'+f.id;
   inputs+=`<label for="${esc(ident)}">${esc(label)}</label>`;
   if(f.type==='select')inputs+=`<select id="${esc(ident)}" name="${esc(f.id)}">${(f.options||[]).map(o=>`<option value="${esc(o)}">${esc(o)}</option>`).join('')}</select>`;
   else inputs+=`<input id="${esc(ident)}" name="${esc(f.id)}" type="${['password','2fa_code','token'].includes(f.type)?'password':'text'}" autocomplete="${f.id==='username'?'username':f.id==='password'?'current-password':'one-time-code'}" ${f.type==='2fa_code'?'inputmode="numeric"':''} maxlength="16000" required>`;
  }
  show('Kết nối Facebook cá nhân',`<p class="help">Kết nối tài khoản Facebook cá nhân. Không cần Meta App ID. Choibox sẽ đăng ký thiết bị Messenger để nhận tin mã hoá.</p><p role="status">${esc(step?.instructions||'Làm theo bước xác thực của Facebook.')}</p>${result.error?`<p class="error" role="alert">${esc(result.error)}</p>`:''}${supported?`<form class="form" data-fb-personal-form>${inputs}<button class="primary" data-fb-personal-submit>Tiếp tục</button></form>`:step?.type==='display_and_wait'?'<button class="primary" data-fb-personal-command="wait">Tôi đã xác nhận trên thiết bị khác</button>':'<p>Chưa có bước xác thực được hỗ trợ. Bạn có thể đóng phiên và thử lại.</p>'}${step?.user_input?.can_cancel||step?.display_and_wait?.can_cancel?'<button data-fb-personal-command="back">Thử cách khác</button>':''}<button data-action="close-modal">Huỷ kết nối</button><p class="help">Mật khẩu và mã xác thực không lưu vào dữ liệu Choibox. Phiên đăng nhập được lưu mã hoá trên máy chủ của bạn. Kết nối không chính thức có thể thay đổi hoặc bị Facebook yêu cầu xác thực lại.</p>`);
  pending(false);
 }
 async function command(method,input){
  if(busy||!flow)return;const current=version,id=flow;pending(true);
  try{const r=await api('/facebook-personal/flows/'+id+'/'+method,'POST',input?{input}:{});if(current===version&&flow===id&&modal.open)render(r);}
  catch(e){if(current===version&&modal.open)render({error:e.message,step});}
  finally{if(current===version)pending(false);}
 }
 modal.addEventListener('submit',event=>{
  const f=event.target.closest('[data-fb-personal-form]');if(!f)return;event.preventDefault();event.stopPropagation();
  const input=Object.fromEntries(new FormData(f));
  for(const key of Object.keys(input))if(/code|otp/.test(key))input[key]=input[key].trim().replace(/[\s-]/g,'');
  f.reset();void command('submit',input);
 });
 modal.addEventListener('click',event=>{
  const b=event.target.closest('[data-fb-personal-command]');if(!b)return;event.preventDefault();event.stopPropagation();void command(b.dataset.fbPersonalCommand);
 });
 async function start(channelId){
  if(busy)return;const old=flow;flow=null;const current=++version;step=null;
  show('Kết nối Facebook cá nhân','<p role="status">Đang mở phiên đăng nhập Facebook…</p><button data-action="close-modal">Huỷ</button>');pending(true);
  try{
   await abandon(old);
   const result=await api('/facebook-personal/start','POST',{channel_id:channelId});
   if(current!==version||!modal.open){void abandon(result.id);return;}
   flow=result.id;render(result);
  }catch(e){if(current===version&&modal.open)show('Chưa mở được Facebook cá nhân',`<p class="error" role="alert">${esc(e.message)}</p><button data-action="connect-facebook-personal">Thử lại</button><button data-action="close-modal">Đóng</button>`);}
  finally{if(current===version)pending(false);}
 }
 return {start};
}
