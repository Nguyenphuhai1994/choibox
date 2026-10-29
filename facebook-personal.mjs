import {spawn} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
const id=v=>/^\d{1,24}$/.test(String(v||''));
const safeError=code=>({
 LOGIN_STEP_FAILED:'Chưa hoàn tất bước xác thực Facebook. Hãy kiểm tra yêu cầu trên Facebook hoặc thử phương thức khác.',
 LOGIN_BACK_FAILED:'Facebook chưa cho quay lại bước trước.',
 ENCRYPTED_CONNECT_FAILED:'Chưa kết nối được Messenger mã hoá.',
 DEVICE_REGISTRATION_FAILED:'Facebook chưa chấp nhận thiết bị Messenger mới.',
 CONNECTOR_UNAVAILABLE:'Máy chủ chưa có bộ kết nối Facebook cá nhân cho hệ điều hành này.',
 CONNECTOR_INTEGRITY_FAILED:'Bộ kết nối không khớp bản đã biên dịch. Cần cài lại từ mã nguồn Choibox.',
 SEND_UNCONFIRMED:'Chưa xác nhận gửi. Kiểm tra tin gốc trên Messenger trước khi gửi lại.'
}[code]||'Bước kết nối Facebook chưa hoàn tất. Không gửi lại tin tự động.');

export const facebookBinaryRoot=root=>path.join(root.replace(/app\.asar(?=$|[/\\])/,'app.asar.unpacked'),'connectors','facebook-personal','bin');

export function facebookWorker({directory,onEvent,onExit}){
 const target=(process.platform==='win32'?'windows':process.platform)+'-'+(process.arch==='x64'?'amd64':process.arch);
 const root=facebookBinaryRoot(ROOT);
 const name='choibox-facebook'+(process.platform==='win32'?'.exe':'');
 const binary=path.join(root,target,name);
 let expected;try{expected=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'))[target];}catch{}
 if(!expected||!fs.existsSync(binary))throw Object.assign(Error('CONNECTOR_UNAVAILABLE'),{code:'CONNECTOR_UNAVAILABLE'});
 const actual=createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
 if(actual!==expected)throw Object.assign(Error('CONNECTOR_INTEGRITY_FAILED'),{code:'CONNECTOR_INTEGRITY_FAILED'});
 fs.mkdirSync(directory,{recursive:true,mode:0o700});fs.chmodSync(directory,0o700);
 const child=spawn(binary,[],{cwd:directory,stdio:['pipe','pipe','ignore'],windowsHide:true,env:{PATH:process.env.PATH||'',TZ:process.env.TZ||'UTC'}});
 let seq=0,buffer='',ended=false,closing=false,resolveClosed;const closedPromise=new Promise(r=>resolveClosed=r),pending=new Map();
 function finish(){if(ended)return;ended=true;resolveClosed(true);for(const p of pending.values()){clearTimeout(p.timer);p.reject(Object.assign(Error('CONNECTOR_EXITED'),{code:'CONNECTOR_EXITED'}));}pending.clear();onExit?.();}
 child.on('error',finish);child.on('exit',finish);
 child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{
  buffer+=chunk;if(buffer.length>2*1024*1024){child.kill();return;}
  let n;while((n=buffer.indexOf('\n'))>=0){let r;const line=buffer.slice(0,n);buffer=buffer.slice(n+1);try{r=JSON.parse(line);}catch{child.kill();return;}
   if(r.id){const p=pending.get(r.id);if(!p)continue;pending.delete(r.id);clearTimeout(p.timer);r.ok?p.resolve(r.data):p.reject(Object.assign(Error(String(r.error||'CONNECTOR_FAILED')),{code:String(r.error||'CONNECTOR_FAILED')}));}
   else if(['message','state','encrypted'].includes(r.event)){try{onEvent?.(r.event,r.data);}catch{/* Database may be closing. */}}
  }
 });
 child.stdin.on('error',()=>{});
 return {
  call(method,params={},timeout=65000){
   if(ended||closing)return Promise.reject(Object.assign(Error('CONNECTOR_EXITED'),{code:'CONNECTOR_EXITED'}));
   return new Promise((resolve,reject)=>{const n=++seq,timer=setTimeout(()=>{pending.delete(n);reject(Object.assign(Error('CONNECTOR_TIMEOUT'),{code:'CONNECTOR_TIMEOUT'}));child.kill();},timeout);timer.unref?.();pending.set(n,{resolve,reject,timer});child.stdin.write(JSON.stringify({id:n,method,params})+'\n');});
  },
  close(){if(!closing){closing=true;child.stdin.end();const timer=setTimeout(()=>{if(!ended)child.kill();},1500);timer.unref?.();}return Promise.race([closedPromise,new Promise(r=>{const t=setTimeout(()=>r(false),4000);t.unref?.();})]);}
 };
}

export function facebookPersonal({db,dataDir,encrypt,decrypt,ingest,avatarBytes,cacheIncomingAttachment,cacheProviderAttachment,factory=facebookWorker,flowMs=300000,retryMs=5000}){
 const get=(s,...p)=>db.prepare(s).get(...p),all=(s,...p)=>db.prepare(s).all(...p),run=(s,...p)=>db.prepare(s).run(...p);
 const channels=new Map(),flows=new Map(),starts=new Map();let closed=false;
 if(!all('PRAGMA table_info(conversations)').some(c=>c.name==='facebook_encrypted'))db.exec('ALTER TABLE conversations ADD COLUMN facebook_encrypted INTEGER DEFAULT 0');
 if(!all('PRAGMA table_info(conversations)').some(c=>c.name==='thread_type'))db.exec("ALTER TABLE conversations ADD COLUMN thread_type TEXT DEFAULT 'user'");
 const base=path.join(dataDir,'facebook-devices');fs.mkdirSync(base,{recursive:true,mode:0o700});
 const channel=n=>get("SELECT * FROM channels WHERE id=? AND provider='facebook_personal'",n);
 const active=f=>!closed&&!f.cancelled&&flows.get(f.id)===f&&Date.now()<f.expires&&!!get('SELECT token FROM sessions WHERE token=? AND expires>?',f.owner,Date.now());
 const live=s=>!closed&&channels.get(s.channelId)===s&&!!channel(s.channelId)?.enabled;
 function health(s){if(!live(s))return;run('UPDATE channels SET verified=?,health=?,last_checked=? WHERE id=?',s.regular||s.encrypted?1:0,s.encrypted?'Messenger cá nhân · đã kết nối mã hoá':s.regular?'Messenger cá nhân · đang kết nối mã hoá':'Messenger cá nhân · mất kết nối',new Date().toISOString(),s.channelId);}
 function receive(s,e){
  if(!live(s)||!id(e?.peer)||!e.id||typeof e.text!=='string')return;
  const time=Number(e.time);if(!Number.isFinite(time)||time<=0||!Number.isFinite(new Date(time).getTime()))return;
  const before=get('SELECT * FROM conversations WHERE channel_id=? AND external_id=?',s.channelId,String(e.peer));
  const exists=before&&get('SELECT id FROM messages WHERE conversation_id=? AND external_id=?',before.id,String(e.id));
  const ch=channel(s.channelId);
  ingest(ch,String(e.peer),String(e.name||'Facebook '+e.peer).slice(0,200),String(e.id).slice(0,200),e.text.slice(0,12000),new Date(time).toISOString(),e.self?'outgoing':'incoming');
  const conv=get('SELECT * FROM conversations WHERE channel_id=? AND external_id=?',s.channelId,String(e.peer));if(!conv)return;
  run("UPDATE conversations SET facebook_encrypted=MAX(facebook_encrypted,?),thread_type=? WHERE id=?",e.encrypted?1:0,e.group?'group':'user',conv.id);
  if(e.author_name)run('UPDATE messages SET author_name=?,author_id=? WHERE conversation_id=? AND external_id=?',String(e.author_name).slice(0,200),id(e.author)?String(e.author):null,conv.id,String(e.id));
  if(e.historical&&!exists)run('UPDATE conversations SET unread=?,status=?,updated=?,hidden_local=? WHERE id=?',before?.unread||0,before?.status||'open',before?.updated&&before.updated>conv.updated?before.updated:conv.updated,before?.hidden_local||0,conv.id);
  if(e.media&&['image','video'].includes(e.media.kind)){
   if(e.media.encrypted)void Promise.resolve(cacheProviderAttachment?.(s.channelId,String(e.peer),String(e.id),e.media)).catch(()=>{});
   else if(typeof e.media.url==='string')void cacheIncomingAttachment?.(s.channelId,String(e.peer),String(e.id),e.media.url,e.media.name||(e.media.kind==='video'?'Video Messenger.mp4':'Ảnh Messenger.jpg'),{kind:e.media.kind,mime:e.media.mime,imageOnly:e.media.kind==='image'}).catch(()=>{});
  }
  // Only Facebook-provided image hosts may be requested; credentials never accompany this fetch.
  if(!e.group){
   run("INSERT INTO customer_profiles(conversation_id,profile_url,link_source,profile_status,checked,retry_at) VALUES(?,?,'provider','unavailable',?,?) ON CONFLICT(conversation_id) DO UPDATE SET checked=excluded.checked",conv.id,'https://www.facebook.com/profile.php?id='+e.peer,Date.now(),Date.now()+3600000);
   if(e.avatar&&avatarBytes&&!s.avatars.has(conv.id)){try{const u=new URL(e.avatar);if(u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&['fbcdn.net','fbsbx.com','facebook.com'].some(d=>u.hostname===d||u.hostname.endsWith('.'+d))){s.avatars.add(conv.id);void avatarBytes(u.href).then(image=>{if(image&&live(s)&&get('SELECT id FROM conversations WHERE id=?',conv.id))run("UPDATE customer_profiles SET avatar=?,avatar_type=?,avatar_updated=?,profile_status='ready' WHERE conversation_id=?",image.data,image.mime,Date.now(),conv.id);}).catch(()=>{});}}catch{}}
  }
 }
 function make(storeKey,channelId=null){
  if(!/^[a-f0-9]{32}$/.test(storeKey))throw Error('INVALID_STORE_KEY');
  const s={channelId,storeKey,regular:false,encrypted:false,connecting:true,startedAt:Date.now(),buffer:[],avatars:new Set(),worker:null,retry:null,closed:false};
  s.worker=factory({directory:path.join(base,storeKey),onEvent:(kind,data)=>{
   if(closed||s.closed)return;
   if(kind==='message'){if(s.channelId)receive(s,data);else if(s.buffer.length<200)s.buffer.push(data);}
   else{if(kind==='state'){s.regular=!!data?.connected;s.connecting=false;}if(kind==='encrypted')s.encrypted=!!data?.connected;health(s);}
  },onExit:()=>{
   if(!live(s)||s.closed)return;s.regular=s.encrypted=false;health(s);
   s.retry=setTimeout(()=>{if(live(s))void restore(channel(s.channelId));},retryMs);s.retry.unref?.();
  }});
  s.handshake=s.worker.call('hello').then(info=>{if(info?.protocol!==1||info?.name!=='choibox-facebook-personal')throw Object.assign(Error('CONNECTOR_PROTOCOL_FAILED'),{code:'CONNECTOR_PROTOCOL_FAILED'});});
  return s;
 }
 function stop(n){const s=channels.get(n);channels.delete(n);if(s){s.closed=true;clearTimeout(s.retry);return s.worker.close();}return true;}
 async function remove(ch){
  for(const f of flows.values())if(f.reconnect===ch.id&&!f.connected)cancel(f);
  let saved;try{saved=decrypt(ch.secret);}catch{}
  const exited=await stop(ch.id);
  if(exited!==false&&/^[a-f0-9]{32}$/.test(saved?.store_key||''))fs.rmSync(path.join(base,saved.store_key),{recursive:true,force:true});
 }
 function cancel(f){if(f.connected)return;f.cancelled=true;clearTimeout(f.timer);f.s.closed=true;f.s.worker.close();f.step=null;}
 async function encrypted(s){
  try{const result=await s.worker.call('encrypted.connect');if(live(s)){s.encrypted=!!result.connected;health(s);}}
  catch{if(live(s))run("UPDATE channels SET health=? WHERE id=?",s.regular?'Messenger thường đã kết nối · mã hoá cần kiểm tra':'Messenger mã hoá chưa kết nối',s.channelId);}
 }
 async function restore(ch){
  if(closed||!ch?.enabled||!ch.secret)return;stop(ch.id);let s;
  try{const saved=decrypt(ch.secret);s=make(saved.store_key,ch.id);channels.set(ch.id,s);
   run("UPDATE channels SET verified=0,health='Đang khôi phục Messenger cá nhân…' WHERE id=?",ch.id);
   await s.handshake;
   const info=await s.worker.call('connect',{cookies:saved.cookies});
   if(!live(s)){s.worker.close();return;}if(String(info.id)!==ch.external_id){stop(ch.id);run("UPDATE channels SET health='Phiên không khớp tài khoản. Kết nối lại Facebook.',verified=0 WHERE id=?",ch.id);return;}
   run('UPDATE channels SET secret=? WHERE id=?',encrypt({...saved,cookies:info.cookies}),ch.id);
   const status=await s.worker.call('state');s.regular=!!status.connected;health(s);void encrypted(s);
  }catch{if(s&&!live(s)){s.closed=true;s.worker.close();}if(s&&live(s)){stop(ch.id);run("UPDATE channels SET health='Không khôi phục được phiên Facebook. Kết nối lại tài khoản.',verified=0 WHERE id=?",ch.id);}}
 }
 async function advance(f,method,input,u,audit){
  if(!active(f))fail(410,'Phiên đăng nhập đã hết hạn.');
  if(f.busy)fail(409,'Đang xử lý bước trước.');f.busy=true;
  try{
   await f.s.handshake;
   const r=await f.s.worker.call(method,{input});
   if(!active(f))return {status:'cancelled'};
   if(r.complete&&r.cookies){
    f.step=null;
    const info=await f.s.worker.call('connect',{cookies:r.cookies});r.cookies=null;
    if(!active(f))return {status:'cancelled'};
    if(!id(info.id)||!info.cookies)throw Error('INVALID_ACCOUNT');
    const old=get("SELECT * FROM channels WHERE provider='facebook_personal' AND external_id=?",String(info.id));
    if(old&&!f.reconnect)fail(409,'Tài khoản này đã có kênh. Chọn Đăng nhập lại Facebook tại kênh hiện có để giữ khoá thiết bị.');
    if(f.reconnect&&String(channel(f.reconnect)?.external_id)!==String(info.id))fail(400,'Tài khoản vừa đăng nhập khác tài khoản cần kết nối lại.');
    const secret=encrypt({cookies:info.cookies,store_key:f.s.storeKey});info.cookies=null;
    let n;if(old){stop(old.id);run("UPDATE channels SET name=?,secret=?,enabled=1,verified=0,health='Đang kết nối Messenger cá nhân…' WHERE id=?",String(info.name||'Facebook cá nhân').slice(0,200),secret,old.id);n=old.id;}else{n=Number(run("INSERT INTO channels(name,provider,external_id,secret,mode,health) VALUES(?,'facebook_personal',?,?,'live','Đang kết nối Messenger cá nhân…')",String(info.name||'Facebook cá nhân').slice(0,200),String(info.id),secret).lastInsertRowid);}
    f.s.channelId=n;channels.set(n,f.s);f.connected=true;f.channelId=n;f.name=info.name;clearTimeout(f.timer);
    const expire=setTimeout(()=>flows.delete(f.id),flowMs);expire.unref?.();
    for(const message of f.s.buffer.splice(0))receive(f.s,message);
    audit(u,null,'Kết nối Facebook cá nhân',String(info.name||'Facebook cá nhân'));
    const state=await f.s.worker.call('state').catch(()=>({}));f.s.regular=!!state.connected;health(f.s);void encrypted(f.s);
    return {status:'connected',channel_id:n,name:info.name};
   }
   if(!r.step)throw Error('MISSING_STEP');
   if(['cookies','qr'].includes(r.step.type)||r.step.user_input?.fields?.some(x=>/captcha/i.test(x.type)))fail(400,'Bước xác thực này chưa được hỗ trợ. Hãy dùng tài khoản thử nghiệm khác; không dán cookie hoặc mã CAPTCHA.');
   f.step=r.step;return {status:'waiting',step:f.step};
  }catch(e){if(!active(f))return {status:'cancelled'};return {status:'waiting',step:f.step,error:e.status?e.message:safeError(e.code||e.message)};}
  finally{f.busy=false;}
 }
 function view(f){return f.connected?{status:'connected',channel_id:f.channelId,name:f.name}:f.cancelled?{status:'cancelled'}:{status:'waiting',step:f.step};}
 async function api({p,req,body,u,session,send,audit}){
  if(!p.startsWith('/api/facebook-personal/'))return false;
  if(u.role!=='admin')fail(403,'Chỉ quản trị viên kết nối Facebook cá nhân.');
  if(p==='/api/facebook-personal/start'&&req.method==='POST'){
   const now=Date.now(),recent=(starts.get(session.token)||[]).filter(t=>now-t<60000);if(recent.length>=4)fail(429,'Vui lòng chờ trước khi tạo phiên Facebook mới.');starts.set(session.token,[...recent,now]);
   for(const f of flows.values())if(f.owner===session.token&&!f.connected){cancel(f);flows.delete(f.id);}
   let storeKey=randomBytes(16).toString('hex');const reconnect=Number(body.channel_id)||null;
   if(reconnect){const ch=channel(reconnect);if(!ch)fail(404,'Không tìm thấy kênh.');storeKey=decrypt(ch.secret).store_key;}
   let s;try{s=make(storeKey);}catch(e){fail(503,safeError(e.code||e.message));}
   const f={id:randomBytes(20).toString('hex'),owner:session.token,expires:now+flowMs,s,reconnect,step:null,busy:false,connected:false,cancelled:false};flows.set(f.id,f);
   f.timer=setTimeout(()=>{cancel(f);if(!f.connected)flows.delete(f.id);},flowMs);f.timer.unref?.();
   return send(201,{id:f.id,...await advance(f,'login.start',undefined,u,audit)})||true;
  }
  const match=p.match(/^\/api\/facebook-personal\/flows\/([a-f0-9]{40})(?:\/(submit|wait|back))?$/);
  if(!match)fail(404,'Không tìm thấy thao tác Facebook cá nhân.');
  const f=flows.get(match[1]);if(!f||f.owner!==session.token)fail(404,'Không tìm thấy phiên đăng nhập.');
  if(req.method==='DELETE'&&!match[2]){cancel(f);flows.delete(f.id);send(200,view(f));return true;}
  if(!active(f)&&!f.connected)fail(410,'Phiên đăng nhập đã hết hạn.');
  if(req.method==='GET'&&!match[2]){send(200,view(f));return true;}
  if(req.method==='POST'&&match[2]){
   const input=body.input;if(match[2]==='submit'&&(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length>8||Object.entries(input).some(([k,v])=>k.length>128||typeof v!=='string'||v.length>16000)))fail(400,'Thông tin xác thực không hợp lệ.');
   if(f.connected){send(200,view(f));return true;}
   send(200,await advance(f,'login.'+match[2],input,u,audit));return true;
  }
  fail(405,'Thao tác không được hỗ trợ.');
 }
 async function send(c,text,attachment){
  if(attachment)fail(400,'Facebook cá nhân hiện chỉ hỗ trợ gửi văn bản.');
  const s=channels.get(c.channel_id);if(!s||!live(s))throw Error('NOT_CONNECTED');
  return s.worker.call('send',{peer:c.external_id,text,encrypted:!!c.facebook_encrypted});
 }
 async function downloadMedia(channelId,descriptor){
  const ch=channel(channelId),s=channels.get(channelId);
  if(!ch?.enabled||!s||!live(s)||!s.encrypted)fail(409,'Kênh Messenger mã hoá đang ngắt. Kết nối lại kênh để xem tệp.');
  const task=async()=>{
   let token;
   try{
    const prepared=await s.worker.call('media.prepare',{media:descriptor});token=prepared.token;
    if(typeof token!=='string'||!/^[a-f0-9]{32}$/.test(token)||!Number.isSafeInteger(prepared.size)||prepared.size<=0||prepared.size>25*1024*1024)throw Error('INVALID_MEDIA_RESULT');
    const parts=[];let offset=0;
    while(offset<prepared.size){
     if(!live(s))fail(409,'Kênh đã ngắt khi đang mở tệp.');
     const r=await s.worker.call('media.chunk',{token,offset});
     if(typeof r.data!=='string'||r.data.length>350000)throw Error('INVALID_MEDIA_CHUNK');
     const data=Buffer.from(r.data,'base64');
     if(!data.length||data.length>256*1024||r.next!==offset+data.length||r.next>prepared.size)throw Error('INVALID_MEDIA_CHUNK');
     parts.push(data);offset=r.next;
    }
    return {data:Buffer.concat(parts,offset),mime:prepared.mime};
   }catch(e){if(e.status)throw e;fail(502,'Không mở được tệp Messenger. Có thể đường dẫn đã hết hạn; thử mở tin gốc.');}
   finally{if(token)await s.worker.call('media.release',{token}).catch(()=>{});}
  };
  const next=(s.mediaQueue||Promise.resolve()).catch(()=>{}).then(task);s.mediaQueue=next;return next;
 }
 async function check(ch){
  if(!ch||closed)return {health:ch?.health||"Kênh đã đóng."};
  const s=channels.get(ch.id);
  if(s){try{const r=await s.worker.call('state',{},55000);if(live(s)){s.regular=!!r.connected;s.encrypted=!!r.encrypted;health(s);}}catch{if(live(s)){s.regular=s.encrypted=false;s.connecting=false;health(s);}}}
  else if(ch.enabled)void restore(ch);
  return {health:channel(ch.id)?.health||'Chưa kết nối.'};
 }
 function connectionState(n){const s=channels.get(n);return s?{connected:s.regular,encrypted:s.encrypted,connecting:!!s.retry||s.connecting&&Date.now()-s.startedAt<90000}:null;}
 const heartbeat=setInterval(()=>{for(const [n,s] of channels){if(s.polling||!live(s))continue;s.polling=true;void check(channel(n)).catch(()=>{}).finally(()=>s.polling=false);}},15000);heartbeat.unref?.();

 function toggle(ch,enabled){stop(ch.id);if(enabled)void restore(channel(ch.id));else run("UPDATE channels SET verified=0,health='Kênh đang tạm dừng.' WHERE id=?",ch.id);}
 function close(){if(closed)return;clearInterval(heartbeat);for(const f of flows.values())if(!f.connected)cancel(f);closed=true;for(const n of channels.keys())stop(n);flows.clear();}
 function cancelSession(session){for(const f of flows.values())if(f.owner===session.token&&!f.connected){cancel(f);flows.delete(f.id);}}
 for(const ch of all("SELECT * FROM channels WHERE provider='facebook_personal'")){run("UPDATE channels SET verified=0,health=? WHERE id=?",ch.enabled?'Đang khôi phục Messenger cá nhân…':'Kênh đang tạm dừng.',ch.id);if(ch.enabled)void restore(ch);}
 return {api,send,downloadMedia,connectionState,check,toggle,stop,remove,close,cancelSession,profile:async()=>{}};
}
