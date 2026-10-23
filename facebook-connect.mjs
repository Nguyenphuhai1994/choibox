import {randomBytes,createHash,createHmac} from 'node:crypto';
const scopes=['pages_show_list','pages_messaging','pages_manage_metadata','pages_read_engagement','pages_read_user_content','pages_manage_engagement'];
const digest=v=>createHash('sha256').update(v).digest('hex');
const error=(status,message)=>{throw Object.assign(new Error(message),{status});};
export function facebookConnect({db,encrypt,decrypt,transport,getPublicUrl}){
 db.exec('CREATE TABLE IF NOT EXISTS integration_settings(name TEXT PRIMARY KEY,secret TEXT NOT NULL)');
 const flows=new Map();
 const config=()=>{const row=db.prepare("SELECT secret FROM integration_settings WHERE name='facebook'").get();return row?decrypt(row.secret):null;};
 const redirect=()=>{const url=getPublicUrl();return url?.startsWith('https://')?url.replace(/\/$/,'')+'/oauth/facebook/callback':'';};
 function prune(){for(const [id,f] of flows)if(f.expires<Date.now())flows.delete(id);}
 function valid(f){return f&&[...flows.values()].includes(f)&&f.expires>Date.now()&&f.redirect===redirect()&&f.revision===config()?.revision&&db.prepare('SELECT token FROM sessions WHERE token=? AND expires>?').get(f.session,Date.now())&&db.prepare("SELECT id FROM users WHERE id=? AND active=1 AND role='admin'").get(f.user);}
 function publicStatus(c){return {configured:!!c,ready:!!c&&!!redirect(),app_id:c?.app_id||'',config_id:c?.config_id||'',graph_version:c?.graph_version||'v25.0',redirect_uri:redirect(),webhook_url:getPublicUrl()?getPublicUrl().replace(/\/$/,'')+'/webhooks/facebook':'',verify_token:c?.verify_token||'',temporary_url:(getPublicUrl()||'').includes('.trycloudflare.com')};}
 function graph(c,path,params={}){return `https://graph.facebook.com/${c.graph_version}/${path}?`+new URLSearchParams(params);}
 async function callback(url,send){
  prune();const state=url.searchParams.get('state')||'';const f=[...flows.values()].find(f=>f.state===digest(state));
  if(!valid(f)||f.status!=='waiting')return send(400,'Phiên kết nối không hợp lệ hoặc đã hết hạn. Quay lại Choibox để bắt đầu lại.','text/plain; charset=utf-8');
  f.status='exchanging';
  if(url.searchParams.has('error')){f.status='failed';f.error='Bạn chưa cấp quyền trên Facebook. Bấm kết nối lại để thử lại.';return send(200,'Đã hủy đăng nhập Facebook. Bạn có thể đóng trang này và quay lại Choibox.','text/plain; charset=utf-8');}
  try{
   const code=url.searchParams.get('code');if(!code||code.length>4096)throw Error();const c=config();
   const short=await transport(graph(c,'oauth/access_token',{client_id:c.app_id,client_secret:c.app_secret,redirect_uri:f.redirect,code}),{method:'GET'});
   if(!short.access_token)throw Error();
   const long=await transport(graph(c,'oauth/access_token',{grant_type:'fb_exchange_token',client_id:c.app_id,client_secret:c.app_secret,fb_exchange_token:short.access_token}),{method:'GET'});
   if(!long.access_token)throw Error();
   const headers={Authorization:'Bearer '+long.access_token},proof=createHmac('sha256',c.app_secret).update(long.access_token).digest('hex');
   const permissions=await transport(graph(c,'me/permissions',{appsecret_proof:proof}),{headers});
   const granted=new Set((permissions.data||[]).filter(x=>x.status==='granted').map(x=>x.permission));
   if(scopes.some(s=>!granted.has(s))){f.status='failed';f.error='Facebook chưa cấp đủ quyền cho tin nhắn và bình luận. Người quản lý ứng dụng Choibox cần kiểm tra quyền Meta, sau đó kết nối lại.';return send(200,'Chưa đủ quyền. Quay lại Choibox để xem hướng dẫn.','text/plain; charset=utf-8');}
   let after='';const pages=new Map();const cursors=new Set();
   for(let i=0;i<20;i++){
    const result=await transport(graph(c,'me/accounts',{fields:'id,name,access_token,tasks',limit:'100',appsecret_proof:proof,...(after?{after}:{})}),{headers});
    for(const p of result.data||[])if(/^\d+$/.test(String(p.id))&&typeof p.access_token==='string')pages.set(String(p.id),{id:String(p.id),name:String(p.name||p.id),access_token:p.access_token});
    if(!result.paging?.next)break;after=result.paging?.cursors?.after;
    if(!after||cursors.has(after)||i===19)throw Error();cursors.add(after);
   }
   if(!valid(f))throw Error();f.pages=[...pages.values()];f.status='ready';
   return send(200,'Đã đăng nhập Facebook. Quay lại cửa sổ Choibox để chọn Page muốn kết nối. Bạn có thể đóng trang này.','text/plain; charset=utf-8');
  }catch{f.status='failed';f.error='Không hoàn tất kết nối Facebook. Kiểm tra cấu hình ứng dụng, địa chỉ trả về và quyền truy cập rồi thử lại.';return send(200,'Chưa hoàn tất kết nối. Quay lại Choibox để thử lại.','text/plain; charset=utf-8');}
 }
 async function api({p,req,body,u,session,send,audit}){
  if(!p.startsWith('/api/facebook/'))return false;
  if(u.role!=='admin')error(403,'Chỉ quản trị viên được kết nối Page.');prune();
  if(p==='/api/facebook/config'&&req.method==='GET'){send(200,publicStatus(config()));return true;}
  if(p==='/api/facebook/config'&&req.method==='POST'){
   const old=config(),c={app_id:String(body.app_id||'').trim(),app_secret:String(body.app_secret||'').trim()||old?.app_secret,config_id:String(body.config_id||'').trim(),graph_version:String(body.graph_version||'v25.0'),verify_token:old?.verify_token||randomBytes(24).toString('hex'),revision:randomBytes(16).toString('hex')};
   if(!/^\d+$/.test(c.app_id)||!c.app_secret||c.app_secret.length>500||c.config_id&&!/^\d+$/.test(c.config_id)||!/^v\d+\.\d+$/.test(c.graph_version))error(400,'Cấu hình ứng dụng Meta không hợp lệ.');
   if(old&&old.app_id!==c.app_id&&!body.app_secret)error(400,'Đổi ứng dụng cần nhập App Secret mới.');
   db.prepare("INSERT INTO integration_settings(name,secret) VALUES('facebook',?) ON CONFLICT(name) DO UPDATE SET secret=excluded.secret").run(encrypt(c));flows.clear();audit(u,null,'Cấu hình đăng nhập Facebook');send(200,publicStatus(c));return true;
  }
  if(p==='/api/facebook/start'&&req.method==='POST'){
   const c=config();if(!c)error(409,'Choibox chưa được cấu hình ứng dụng Meta. Người quản lý triển khai cần hoàn tất cấu hình một lần.');if(!redirect())error(409,'Máy chủ cần địa chỉ HTTPS để nhận kết quả đăng nhập Facebook.');
   for(const [id,f] of flows)if(f.session===session.token)flows.delete(id);
   const id=randomBytes(24).toString('hex'),state=randomBytes(32).toString('hex');
   flows.set(id,{state:digest(state),session:session.token,user:u.id,revision:c.revision,redirect:redirect(),status:'waiting',expires:Date.now()+600000,pages:[]});
   const args={client_id:c.app_id,redirect_uri:redirect(),state,response_type:'code',...(c.config_id?{config_id:c.config_id}:{scope:scopes.join(','),auth_type:'rerequest'})};
   send(200,{id,url:`https://www.facebook.com/${c.graph_version}/dialog/oauth?`+new URLSearchParams(args)});return true;
  }
  const m=p.match(/^\/api\/facebook\/flows\/([a-f0-9]{48})(?:\/(connect))?$/);
  if(m){const f=flows.get(m[1]);if(!valid(f)||f.session!==session.token)error(410,'Phiên kết nối hết hạn. Bấm kết nối Facebook để bắt đầu lại.');
   if(req.method==='DELETE'&&!m[2]){flows.delete(m[1]);send(200,{ok:true});return true;}
   if(req.method==='GET'&&!m[2]){send(200,{status:f.status,error:f.error,pages:f.status==='ready'?f.pages.map(p=>({id:p.id,name:p.name,connected:!!db.prepare("SELECT id FROM channels WHERE provider='facebook' AND external_id=?").get(p.id)})):[]});return true;}
   if(req.method==='POST'&&m[2]==='connect'){
    if(f.status!=='ready')error(409,'Chưa sẵn sàng chọn Page.');const ids=body.page_ids;
    if(!Array.isArray(ids)||!ids.length||ids.length>100||new Set(ids).size!==ids.length||ids.some(id=>!f.pages.some(p=>p.id===id)))error(400,'Chọn ít nhất một Page trong danh sách.');
    f.status='connecting';const results=[];const c=config();
    try{for(const id of ids){
     if(!valid(f))error(410,'Phiên kết nối thay đổi. Hãy kết nối lại.');
     const page=f.pages.find(p=>p.id===id),secret={access_token:page.access_token,app_secret:c.app_secret,app_id:c.app_id,verify_token:c.verify_token,graph_version:c.graph_version};
     db.prepare("INSERT INTO channels(name,provider,external_id,secret,verified,health) VALUES(?,'facebook',?,?,1,'Đang đăng ký nhận sự kiện') ON CONFLICT(provider,external_id) DO UPDATE SET name=excluded.name,secret=excluded.secret,enabled=1,verified=1,health=excluded.health").run(page.name,id,encrypt(secret));
     try{const r=await transport(graph(c,id+'/subscribed_apps'),{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+page.access_token},body:JSON.stringify({subscribed_fields:'messages,messaging_postbacks,message_deliveries,message_reads,feed',appsecret_proof:createHmac('sha256',c.app_secret).update(page.access_token).digest('hex')})});if(r.success!==true)throw Error();
      db.prepare("UPDATE channels SET health='Đã kết nối Facebook',last_checked=? WHERE provider='facebook' AND external_id=?").run(new Date().toISOString(),id);results.push({id,name:page.name,ok:true});audit(u,null,'Kết nối Page qua Facebook',page.name);
     }catch{db.prepare("UPDATE channels SET health='Chưa đăng ký được webhook' WHERE provider='facebook' AND external_id=?").run(id);results.push({id,name:page.name,ok:false,error:'Đã lưu Page nhưng chưa nhận được sự kiện. Kiểm tra quyền Meta và thử kết nối lại.'});}
    }}finally{f.status='ready';}
    send(200,{results});return true;
   }
  }
  error(404,'Thao tác Facebook không tồn tại.');
 }
 return {api,callback,verify(token){const c=config();return !!c&&typeof token==='string'&&digest(token)===digest(c.verify_token);}};
}
