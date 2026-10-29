import {randomUUID} from 'node:crypto';
import {Zalo, ThreadType, LoginQRCallbackEventType as QR} from 'zca-js';
import {imageSize} from 'image-size';
import {zaloRecovery} from './zalo-recovery.mjs';
import {zaloContent} from './zalo-content.mjs';

const now=()=>new Date().toISOString();
const text=(s,n=200)=>String(s??'').trim().slice(0,n);
const problem=(status,message)=>{throw Object.assign(new Error(message),{status});};
const activeFlow=f=>['starting','qr','scanned','connecting'].includes(f.status);
const options={logging:false,checkUpdate:false,selfListen:true,polyfill:(url,init={})=>fetch(url,{...init,signal:init.signal?AbortSignal.any([init.signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)})};
const stopApi=api=>{try{api?.listener.stop();}catch{/* already stopped */}};
export const createZalo=()=>new Zalo(options);

// Login credentials never leave the customer's server or its encrypted channel row.
export function zaloPersonal({db,encrypt,decrypt,ingest,avatarBytes,cacheIncomingAttachment,factory=createZalo,flowMs=180000,retryMs=5000,recoveryOptions={}}){
 const get=(s,...p)=>db.prepare(s).get(...p),all=(s,...p)=>db.prepare(s).all(...p),run=(s,...p)=>db.prepare(s).run(...p);
 if(!all('PRAGMA table_info(conversations)').some(c=>c.name==='thread_type'))db.exec("ALTER TABLE conversations ADD COLUMN thread_type TEXT DEFAULT 'user'");
 if(!all('PRAGMA table_info(messages)').some(c=>c.name==='author_id'))db.exec('ALTER TABLE messages ADD COLUMN author_id TEXT');
 function target(c){const group=c.thread_type==='group',id=group?c.external_id.replace(/^group:/,''):c.external_id;if(!/^\d+$/.test(id)||group&&!c.external_id.startsWith('group:'))problem(400,'Hội thoại Zalo không hợp lệ.');return {id,type:group?ThreadType.Group:ThreadType.User};}
 const flows=new Map(),connections=new Map(),profiles=new Map(),mediaPending=new Set(),mediaQueue=[];let mediaRunning=0,closed=false;
 // Repair the old one-day negative avatar cache after updating from 1.8.0.
 run("UPDATE customer_profiles SET retry_at=0 WHERE avatar IS NULL AND conversation_id IN (SELECT c.id FROM conversations c JOIN channels ch ON ch.id=c.channel_id WHERE ch.provider='zalo_personal')");
 const recovery=zaloRecovery({db,...recoveryOptions,ingest:(id,e,from)=>{const c=channel(id),s=connections.get(id);return c&&s?receive(c,s,e,true,from):false;}});
 const channel=id=>get("SELECT * FROM channels WHERE id=? AND provider='zalo_personal'",id);
 db.exec(`CREATE TABLE IF NOT EXISTS zalo_author_avatars(channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,author_id TEXT NOT NULL,avatar BLOB,avatar_type TEXT,checked INTEGER DEFAULT 0,retry_at INTEGER DEFAULT 0,PRIMARY KEY(channel_id,author_id))`);
 const authorPending=new Map();let authorQueue=Promise.resolve();
 // One lookup at a time, shared across messages by account and sender. Never expose provider URLs.
 async function authorAvatar(c,authorId){
  if(!/^\d{1,100}$/.test(authorId))return;
  const cached=get('SELECT * FROM zalo_author_avatars WHERE channel_id=? AND author_id=?',c.channel_id,authorId),ch=channel(c.channel_id),s=connections.get(c.channel_id);
  if(!ch?.enabled||!s?.ready||closed||cached?.retry_at>Date.now())return cached;
  const key=c.channel_id+':'+authorId;if(authorPending.has(key))return cached?.avatar?cached:authorPending.get(key);
  if(authorPending.size>=100)return cached;
  const task=authorQueue.then(async()=>{
   if(!live(ch,s))return cached;
   let image;try{
    const data=await s.api.getUserInfo(authorId),items=data.changed_profiles||{},p=items[authorId]||items[authorId+'_0']||Object.values(items).find(p=>String(p.userId||p.uid)===authorId);
    for(const url of [p?.avatar,p?.avatarUrl,p?.avatar_url].filter(v=>typeof v==='string'&&v)){image=await avatarBytes(url).catch(()=>null);if(image)break;}
   }catch{/* Keep a previous photo and retry transient failures later. */}
   if(!live(ch,s))return cached;
   run('INSERT INTO zalo_author_avatars(channel_id,author_id,avatar,avatar_type,checked,retry_at) VALUES(?,?,?,?,?,?) ON CONFLICT(channel_id,author_id) DO UPDATE SET avatar=COALESCE(excluded.avatar,avatar),avatar_type=COALESCE(excluded.avatar_type,avatar_type),checked=excluded.checked,retry_at=excluded.retry_at',ch.id,authorId,image?.data||null,image?.mime||null,Date.now(),Date.now()+(image?86400000:60000));
   return get('SELECT * FROM zalo_author_avatars WHERE channel_id=? AND author_id=?',ch.id,authorId);
  }).finally(()=>authorPending.delete(key));authorPending.set(key,task);authorQueue=task.catch(()=>{});
  if(cached?.avatar){void task.catch(()=>{});return cached;}return task;
 }
 function health(id,message,verified=0){if(!closed)run('UPDATE channels SET health=?,verified=?,last_checked=? WHERE id=?',message,verified,now(),id);}
 function finish(f,status,error=''){
  if(!activeFlow(f))return;
  f.status=status;f.error=error;f.qr='';f.credentials=null;clearTimeout(f.timer);
  try{f.abort?.();}catch{/* abort may already have completed */}
 }
 function cancelSession(session){for(const f of flows.values())if(f.owner===session.token)finish(f,'cancelled');}
 function live(c,s){return !closed&&connections.get(c.id)===s&&!!channel(c.id)?.enabled;}
 function stop(id){recovery.disconnect(id);const s=connections.get(id);connections.delete(id);if(s){clearTimeout(s.retry);clearTimeout(s.connectTimer);stopApi(s.api);} }
 function readCredentials(api,fallback){const ctx=api.getContext();return {cookie:ctx.cookie?.toJSON()?.cookies||fallback?.cookie,imei:ctx.imei||fallback?.imei,userAgent:ctx.userAgent||fallback?.userAgent};}
 async function profile(c,{force=false}={}){
  const ch=channel(c.channel_id),s=connections.get(c.channel_id);if(!ch?.enabled||!s?.ready||closed)return;
  const cached=get('SELECT checked,retry_at,avatar IS NOT NULL has_avatar FROM customer_profiles WHERE conversation_id=?',c.id);
  if(cached?.retry_at>Date.now()&&(!force||cached.checked>Date.now()-15000))return;
  if(profiles.has(c.id))return profiles.get(c.id);
  const task=(async()=>{
   run("INSERT INTO customer_profiles(conversation_id,checked,retry_at,profile_status) VALUES(?,?,?,'loading') ON CONFLICT(conversation_id) DO UPDATE SET checked=excluded.checked,retry_at=excluded.retry_at,profile_status='loading'",c.id,Date.now(),Date.now()+60000);
   try{
    const group=c.thread_type==='group',thread=target(c),data=group?await s.api.getGroupInfo(thread.id):await s.api.getUserInfo(thread.id),items=group?data.gridInfoMap||{}:data.changed_profiles||{},p=items[thread.id]||(!group&&(items[thread.id+'_0']||Object.values(items).find(p=>String(p.userId||p.uid)===thread.id)));
    if(!live(ch,s))return;if(!p)throw Error('Profile not returned');
    let image=null;for(const url of [group?p.fullAvt:p.avatar,group?p.avt:p.avatarUrl,p.avatar_url].filter(v=>typeof v==='string'&&v)){image=await avatarBytes(url).catch(()=>null);if(image)break;}
    if(!live(ch,s)||!get('SELECT id FROM conversations WHERE id=?',c.id))return;
    const name=text(group?p.name:p.displayName||p.zaloName);if(name)run('UPDATE conversations SET name=? WHERE id=?',name,c.id);
    // A personal Zalo UID is not a public profile URL. Only a returned phone is usable.
    const phone=group?'':text(p.phoneNumber,40),link=/^\+?\d{9,15}$/.test(phone)?'https://zalo.me/'+phone.replace(/^\+/,''):'';
    if(link)run("UPDATE customer_profiles SET profile_url=?,link_source='provider' WHERE conversation_id=? AND (profile_url='' OR link_source='provider')",link,c.id);
    if(image)run('UPDATE customer_profiles SET avatar=?,avatar_type=?,avatar_updated=? WHERE conversation_id=?',image.data,image.mime,Date.now(),c.id);
    run("UPDATE customer_profiles SET profile_status=?,profile_reason=NULL,retry_at=? WHERE conversation_id=?",image||cached?.has_avatar?'ready':'unavailable',Date.now()+(image?86400000:60000),c.id);
   }catch{if(live(ch,s))run("UPDATE customer_profiles SET profile_status=?,profile_reason=NULL WHERE conversation_id=?",cached?.has_avatar?'ready':'unavailable',c.id);}
  })().finally(()=>profiles.delete(c.id));profiles.set(c.id,task);return task;
 }
 function media(c,s,peer,id,content){
  const key=c.id+':'+peer+':'+id,m=get('SELECT m.attachment_id,m.local_deleted,co.hidden_local FROM messages m JOIN conversations co ON co.id=m.conversation_id WHERE co.channel_id=? AND co.external_id=? AND m.external_id=?',c.id,peer,id);
  if(!m||m.attachment_id||m.local_deleted||m.hidden_local||mediaPending.has(key)||mediaQueue.length>=500)return;
  mediaPending.add(key);mediaQueue.push({c,s,peer,id,content,key});pump();
 }
 function pump(){
  while(!closed&&mediaRunning<2&&mediaQueue.length){const job=mediaQueue.shift();mediaRunning++;
   void (async()=>{
    if(!live(job.c,job.s))return;const {content}=job;let sources=content.sources;
    if(content.kind==='sticker'&&content.stickerId){
     try{const details=await job.s.api.getStickersDetail(content.stickerId),sticker=details?.find(d=>String(d.id)===String(content.stickerId));if(sticker)sources=[sticker.stickerWebpUrl,sticker.stickerUrl,...sources,sticker.uri].filter(v=>typeof v==='string'&&v);}catch{/* Embedded URLs may still work. */}
    }
    for(const url of [...new Set(sources)]){if(!live(job.c,job.s))return;if(await cacheIncomingAttachment?.(job.c.id,job.peer,job.id,url,content.kind==='sticker'?'Sticker Zalo':content.body,{imageOnly:['sticker','image','gif'].includes(content.kind),kind:content.kind,urls:sources}))break;}
   })().catch(()=>{}).finally(()=>{mediaPending.delete(job.key);mediaRunning--;pump();});
  }
 }
 function receive(c,s,event,historical=false,recoverFrom=null){
  if(!live(c,s)||![ThreadType.User,ThreadType.Group].includes(event?.type)||!event.data)return;
  const d=event.data,id=text(d.msgId,100),rawPeer=text(event.threadId,100),group=event.type===ThreadType.Group,peer=group?'group:'+rawPeer:rawPeer;if(!/^\d+$/.test(rawPeer)||!/^\d+$/.test(id))return;
  const rawTime=Number(d.ts),time=Number.isFinite(rawTime)&&rawTime>0?rawTime:Date.now();if(!Number.isFinite(new Date(time).getTime()))return;
  const content=zaloContent(d),body=content.body;
  // Preserve hidden/deleted history and avoid marking downloaded history as new unread mail.
  const before=get('SELECT * FROM conversations WHERE channel_id=? AND external_id=?',c.id,peer);
  const existed=before&&get('SELECT id FROM messages WHERE conversation_id=? AND external_id=?',before.id,id);
  ingest(c,peer,group?before?.name||'Nhóm Zalo '+rawPeer:event.isSelf?before?.name||'Khách Zalo':text(d.dName)||'Khách Zalo',id,body,new Date(time).toISOString(),event.isSelf?'outgoing':'incoming');
  let conv=get('SELECT * FROM conversations WHERE channel_id=? AND external_id=?',c.id,peer);
  if(group&&conv){run("UPDATE conversations SET thread_type='group' WHERE id=?",conv.id);conv={...conv,thread_type:'group'};const authorId=text(d.uidFrom,100);run('UPDATE messages SET author_name=?,author_id=? WHERE conversation_id=? AND external_id=? AND local_deleted=0',event.isSelf?c.name:text(d.dName)||'Thành viên '+authorId,authorId,conv.id,id);}
  if(!group&&conv&&!event.isSelf&&text(d.dName))run('UPDATE conversations SET name=? WHERE id=?',text(d.dName),conv.id);
  if(conv&&['sticker','image','gif','video','file'].includes(content.kind)){
   // Replayed history repairs placeholders saved by older versions, including our own stickers.
   run('UPDATE messages SET body=? WHERE conversation_id=? AND external_id=? AND local_deleted=0 AND attachment_id IS NULL',body,conv.id,id);
   media(c,s,peer,id,content);
  }
  const inserted=conv&&!existed&&!!get('SELECT id FROM messages WHERE conversation_id=? AND external_id=?',conv.id,id),missed=inserted&&recoverFrom!==null&&time>=recoverFrom;
  if(historical&&conv&&!existed){run('UPDATE conversations SET unread=?,status=?,updated=?,hidden_local=? WHERE id=?',missed&&!event.isSelf?(before?.unread||0)+1:before?.unread||0,missed&&!event.isSelf?'open':before?.status||'open',before?.updated&&before.updated>conv.updated?before.updated:conv.updated,missed&&!event.isSelf?0:before?.hidden_local||0,conv.id);}
  if(conv&&!conv.hidden_local)void profile(conv);
  return !!inserted;
 }
 function attach(c,s,api){
  s.api=api;s.ready=false;
  const current=()=>live(c,s)&&s.api===api;
  api.listener.on('error',()=>{if(current())health(c.id,'Zalo gặp lỗi tạm thời. Đang theo dõi kết nối.',s.ready?1:0);});
  api.listener.on('connected',()=>{
   if(!current()){stopApi(api);return;}clearTimeout(s.connectTimer);s.connectTimer=null;s.ready=true;s.retries=0;health(c.id,'Đang kết nối Zalo cá nhân',1);
   try{run('UPDATE channels SET secret=? WHERE id=?',encrypt(readCredentials(api)),c.id);}catch{/* existing encrypted credentials remain */}
   recovery.connect(c.id,(type,cursor)=>api.listener.requestOldMessages(type,cursor));
  });
  api.listener.on('message',event=>{if(!current())return;try{receive(c,s,event);}catch{/* one malformed event must not stop other accounts */}});
  api.listener.on('old_messages',(events,type)=>{if(!current()||![ThreadType.User,ThreadType.Group].includes(type)||!Array.isArray(events))return;if(recovery.page(c.id,type,events))return;for(const event of events.slice(0,500))if(event.type===type)try{receive(c,s,event,true);}catch{/* malformed event */}});
  api.listener.on('seen_messages',events=>{if(!current())return;for(const event of events||[])if(event.type===ThreadType.User&&!event.isSelf){run("UPDATE messages SET status='read' WHERE external_id=? AND kind='outgoing' AND status='sent' AND conversation_id IN (SELECT id FROM conversations WHERE channel_id=? AND external_id=?)",String(event.data?.msgId||''),c.id,String(event.threadId));}});
  api.listener.on('closed',code=>{
   if(!current())return;recovery.disconnect(c.id);clearTimeout(s.connectTimer);s.connectTimer=null;s.ready=false;s.api=null;
   if(code===3000||code===3003){s.blocked=true;health(c.id,'Phiên Zalo đã được mở ở nơi khác hoặc bị thu hồi. Đóng Zalo Web rồi quét QR lại.');return;}
   retry(c,s);
  });
  s.connectTimer=setTimeout(()=>{if(current()&&!s.ready){s.api=null;stopApi(api);retry(c,s);}},30000);s.connectTimer.unref?.();
  api.listener.start({retryOnClose:false});
 }
 function retry(c,s){
  if(!live(c,s)||s.retry)return;s.ready=false;
  if((s.retries||0)>=5){health(c.id,'Không kết nối lại được Zalo. Kiểm tra mạng rồi bấm Kết nối lại.');return;}
  health(c.id,'Mất kết nối Zalo. Đang tự kết nối lại…');
  const delay=Math.min(60000,retryMs*2**(s.retries||0));s.retries=(s.retries||0)+1;
  s.retry=setTimeout(()=>{s.retry=null;if(live(c,s))void restore(c,s);},delay);s.retry.unref?.();
 }
 async function restore(c,previous){
  if(closed||!channel(c.id)?.enabled||previous?.restoring)return;
  const s=previous||{retries:0};if(!previous){stop(c.id);connections.set(c.id,s);}s.restoring=true;health(c.id,'Đang khôi phục phiên Zalo…');
  try{const api=await factory().login(structuredClone(decrypt(channel(c.id).secret)));if(!live(c,s)){stopApi(api);return;}if(String(api.getContext().uid)!==c.external_id){stopApi(api);s.blocked=true;health(c.id,'Phiên Zalo không đúng tài khoản. Hãy quét QR để kết nối lại.');return;}attach(c,s,api);}catch{if(live(c,s))retry(c,s);}finally{s.restoring=false;}
 }
 async function login(f){
  try{
   const api=await factory().loginQR({language:'vi'},event=>{
    if(!activeFlow(f)||closed){try{event.actions?.abort();}catch{}return;}
    if(event.actions?.abort)f.abort=event.actions.abort;
    if(event.type===QR.QRCodeGenerated){const b64=String(event.data.image).replace(/^data:image\/png;base64,/,'');if(b64.length>1500000||!/^[A-Za-z0-9+/=\r\n]+$/.test(b64)){finish(f,'failed','Zalo trả về mã QR không hợp lệ.');return;}f.qr='data:image/png;base64,'+b64;f.status='qr';f.expires=Date.now()+100000;}
    else if(event.type===QR.QRCodeExpired)finish(f,'expired','Mã QR đã hết hạn. Bấm Tạo mã QR mới.');
    else if(event.type===QR.QRCodeScanned){f.status='scanned';f.name=text(event.data.display_name);f.qr='';}
    else if(event.type===QR.QRCodeDeclined)finish(f,'declined','Bạn đã từ chối đăng nhập trên điện thoại.');
    else if(event.type===QR.GotLoginInfo){f.status='connecting';f.qr='';f.credentials=event.data;f.abort=null;}
   });
   if(closed||!activeFlow(f)||!get('SELECT token FROM sessions WHERE token=? AND expires>?',f.owner,Date.now())){stopApi(api);finish(f,'cancelled');return;}
   const ctx=api.getContext(),uid=String(ctx.uid||'');if(!/^\d+$/.test(uid))throw Error('Invalid account');
   const credentials=readCredentials(api,f.credentials);if(!credentials.cookie?.length||!credentials.imei||!credentials.userAgent)throw Error('Missing credentials');
   let name=f.name||'Zalo cá nhân';try{const info=await api.fetchAccountInfo();name=text(info.profile?.displayName||info.profile?.zaloName)||name;}catch{/* Scanned account name is enough. */}
   if(closed||!activeFlow(f)||!get('SELECT token FROM sessions WHERE token=? AND expires>?',f.owner,Date.now())){stopApi(api);finish(f,'cancelled');return;}
   const old=get("SELECT * FROM channels WHERE provider='zalo_personal' AND external_id=?",uid);
   if(f.channelId&&(!channel(f.channelId)||old?.id!==f.channelId)){stopApi(api);finish(f,'failed','Mã QR không thuộc tài khoản Zalo của kênh cần kết nối lại.');return;}
   const id=old?.id||Number(run("INSERT INTO channels(name,provider,external_id,secret,health) VALUES(?,'zalo_personal',?,?,?)",name,uid,encrypt(credentials),'Đang kết nối Zalo…').lastInsertRowid);
   if(old)run('UPDATE channels SET secret=?,name=?,verified=0 WHERE id=?',encrypt(credentials),name,id);
   stop(id);const c=channel(id),s={retries:0};connections.set(id,s);
   if(c.enabled){try{attach(c,s,api);}catch{retry(c,s);}}else{connections.delete(id);stopApi(api);health(id,'Kênh đang tạm dừng.');}
   f.channelId=id;f.status='connected';f.name=name;f.qr='';f.credentials=null;clearTimeout(f.timer);f.abort=null;
  }catch{if(activeFlow(f))finish(f,'failed','Chưa đăng nhập được Zalo. Kiểm tra mạng và tạo lại mã QR.');}
 }
 function safeFlow(f){return {id:f.id,status:f.status,qr:f.qr||undefined,expires:f.expires||null,name:f.name||'',error:f.error||'',channel_id:f.status==='connected'?f.channelId:undefined};}
 async function api({p,req,body,u,session,send,audit}){
  if(!p.startsWith('/api/zalo-personal/'))return false;
  if(u.role!=='admin')problem(403,'Chỉ quản trị viên được kết nối Zalo cá nhân.');
  const sync=p.match(/^\/api\/zalo-personal\/channels\/(\d+)\/sync$/);if(sync&&req.method==='POST'){const id=Number(sync[1]);if(!channel(id))problem(404,'Không tìm thấy kênh Zalo.');recovery.retry(id,{restart:body.restart===true});send(200,{ok:true});return true;}
  if(p==='/api/zalo-personal/start'&&req.method==='POST'){
   if(body.channel_id&&!channel(Number(body.channel_id)))problem(404,'Không tìm thấy kênh Zalo cá nhân.');
   if([...flows.values()].filter(f=>Date.now()-f.created<10000).length>=6)problem(429,'Bạn đang tạo QR quá nhanh. Vui lòng chờ 10 giây.');
   cancelSession(session);for(const [id,f] of flows)if(Date.now()-f.created>300000)flows.delete(id);
   if([...flows.values()].filter(activeFlow).length>=3)problem(429,'Đang có quá nhiều phiên quét QR. Hãy đóng phiên cũ.');
   const f={id:randomUUID(),owner:session.token,created:Date.now(),status:'starting',channelId:body.channel_id?Number(body.channel_id):null};
   f.timer=setTimeout(()=>finish(f,'expired','Phiên quét QR đã hết hạn. Hãy tạo lại mã.'),flowMs);f.timer.unref?.();flows.set(f.id,f);void login(f);audit(u,null,'Bắt đầu kết nối Zalo cá nhân');send(201,safeFlow(f));return true;
  }
  const m=p.match(/^\/api\/zalo-personal\/flows\/([a-f0-9-]{36})$/),f=m&&flows.get(m[1]);
  if(!f||f.owner!==session.token||Date.now()-f.created>300000)problem(404,'Phiên quét QR đã kết thúc.');
  if(req.method==='DELETE'){const connected=f.status==='connected';finish(f,'cancelled');flows.delete(f.id);send(200,{ok:true,connected});return true;}
  if(req.method==='GET'){send(200,safeFlow(f));return true;}
  problem(405,'Thao tác không hỗ trợ.');
 }
 async function send(c,message,attachment){
  const s=connections.get(c.channel_id);if(!s?.ready||!channel(c.channel_id)?.enabled)problem(409,'Zalo cá nhân chưa kết nối. Quản trị viên cần kiểm tra hoặc quét QR lại.');
  let content=message;
  if(attachment){const data=Buffer.from(attachment.data),metadata={totalSize:data.length};if(attachment.mime.startsWith('image/')){const size=imageSize(data);if(!size.width||!size.height)problem(400,'Không đọc được kích thước ảnh.');metadata.width=size.width;metadata.height=size.height;}content={msg:'',attachments:{data,filename:attachment.name,metadata}};}
  let timer,result;const thread=target(c);
  try{result=await Promise.race([s.api.sendMessage(content,thread.id,thread.type),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Zalo did not acknowledge sending in time')),60000);timer.unref?.();})]);}finally{clearTimeout(timer);}
  const ids=[result?.message?.msgId,...(result?.attachment||[]).map(a=>a.msgId)].filter(id=>id!==undefined&&id!==null).map(String);
  if(!ids.length)throw Error('Zalo has not acknowledged a message');return {message_id:ids[0]};
 }
 function check(c){const s=connections.get(c.id);if(s?.ready)return {health:'Đang kết nối Zalo cá nhân'};if(s?.blocked||s?.restoring||s?.retry||s?.connectTimer)return {health:c.health};void restore(c);return {health:c.enabled?'Đang khôi phục phiên Zalo…':'Kênh đang tạm dừng.'};}
 function toggle(c,enabled){stop(c.id);if(enabled)void restore(channel(c.id));else health(c.id,'Kênh đang tạm dừng.');}
 function close(){if(closed)return;recovery.close();closed=true;mediaQueue.length=0;for(const f of flows.values())finish(f,'cancelled');flows.clear();for(const id of connections.keys())stop(id);}
 for(const c of all("SELECT * FROM channels WHERE provider='zalo_personal'")){health(c.id,c.enabled?'Đang khôi phục phiên Zalo…':'Kênh đang tạm dừng.');if(c.enabled)void restore(c);}
 function connectionState(id){const s=connections.get(id);return s?{connected:!!s.ready,connecting:!!(s.restoring||s.retry||s.connectTimer)}:null;}
 return {api,profile,authorAvatar,send,connectionState,check,toggle,stop,cancelSession,close,syncState:recovery.state};
}
