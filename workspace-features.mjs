import {randomUUID} from 'node:crypto';
import {mediaCache} from './media-cache.mjs';
import {customerProfiles} from './customer-profile.mjs';

const problem=(status,message)=>{throw Object.assign(new Error(message),{status});};
const text=(s,max=200)=>String(s??'').trim().slice(0,max);
const formats={jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',gif:'image/gif',webp:'image/webp',mp4:'video/mp4',mov:'video/quicktime',webm:'video/webm',mp3:'audio/mpeg',wav:'audio/wav',pdf:'application/pdf',txt:'text/plain',csv:'text/csv',doc:'application/msword',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',xls:'application/vnd.ms-excel',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',zip:'application/zip'};
export const MAX_ATTACHMENT=25*1024*1024;
export function profileLink(value,provider){
 if(!value)return '';try{const u=new URL(value);const hosts=provider==='facebook'?['facebook.com','www.facebook.com','m.facebook.com']:['zalo.me','www.zalo.me'];if(u.protocol!=='https:'||!hosts.includes(u.hostname)||u.username||u.password||u.port)return '';if(u.pathname==='/'||/access_token|code|token/i.test(u.search))return '';u.hash='';return u.href;}catch{return '';}
}
function cdnUrl(value){if(typeof value!=="string"||value.length>8192)return null;try{const u=new URL(value);if(u.protocol==='http:'&&['zdn.vn','zadn.vn','zaloapp.com'].some(d=>u.hostname.endsWith('.'+d)))u.protocol='https:';if(u.protocol!=='https:'||u.username||u.password||u.port||[...u.searchParams.keys()].some(k=>/access_token|appsecret/i.test(k)))return null;if(['fbcdn.net','fbsbx.com','facebook.com','zdn.vn','zadn.vn','zaloapp.com'].some(d=>u.hostname.endsWith('.'+d)))return u.href;}catch{}return null;}
export function workspaceFeatures({db,dataDir,encrypt,decrypt,transport,allowed,conversation,audit,fetchImage=fetch,personalProfile,personalAuthorAvatar,providerMedia}){
 const get=(s,...p)=>db.prepare(s).get(...p),all=(s,...p)=>db.prepare(s).all(...p),run=(s,...p)=>db.prepare(s).run(...p);
 db.exec(`CREATE TABLE IF NOT EXISTS customer_profiles(conversation_id INTEGER PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,avatar BLOB,avatar_type TEXT,profile_url TEXT DEFAULT '',phone TEXT DEFAULT '',address TEXT DEFAULT '',checked INTEGER DEFAULT 0);
 CREATE TABLE IF NOT EXISTS tag_colors(name TEXT PRIMARY KEY,color TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY,conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,name TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,data BLOB NOT NULL,created TEXT NOT NULL,message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE);
 CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY,conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,request_id TEXT NOT NULL,customer TEXT NOT NULL,phone TEXT,address TEXT,items TEXT NOT NULL,shipping INTEGER NOT NULL,discount INTEGER NOT NULL,total INTEGER NOT NULL,note TEXT,status TEXT DEFAULT 'new',version INTEGER DEFAULT 1,created TEXT,updated TEXT,created_by INTEGER REFERENCES users(id),UNIQUE(conversation_id,request_id));`);
 if(!all('PRAGMA table_info(messages)').some(c=>c.name==='attachment_id'))db.exec('ALTER TABLE messages ADD COLUMN attachment_id TEXT');
 if(!all('PRAGMA table_info(messages)').some(c=>c.name==='order_id'))db.exec('ALTER TABLE messages ADD COLUMN order_id INTEGER');
 if(!all('PRAGMA table_info(conversations)').some(c=>c.name==='contact_id'))db.exec('ALTER TABLE conversations ADD COLUMN contact_id TEXT');
 async function downloadCdn(url,limit,accepted,fallback=''){
  for(let hop=0;hop<4;hop++){url=cdnUrl(url);if(!url)return null;const r=await fetchImage(url,{redirect:'manual',signal:AbortSignal.timeout(20000)});if(r.status>=300&&r.status<400){url=new URL(r.headers.get('location'),url).href;continue;}if(!r.ok)return null;let mime=(r.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();if(mime==='image/jpg')mime='image/jpeg';const sniff=!mime||mime==='application/octet-stream';if(!accepted.includes(mime)&&!sniff){await r.body?.cancel?.().catch(()=>{});return null;}if(Number(r.headers.get('content-length'))>limit){await r.body?.cancel?.().catch(()=>{});return null;}
   let size=0;const parts=[];for await(const chunk of r.body){size+=chunk.length;if(size>limit){await r.body.cancel?.().catch(()=>{});return null;}parts.push(Buffer.from(chunk));}const data=Buffer.concat(parts);if(sniff){mime=data.subarray(0,8).toString('hex')==='89504e470d0a1a0a'?'image/png':data.subarray(0,3).toString('hex')==='ffd8ff'?'image/jpeg':/^GIF8[79]a$/.test(data.subarray(0,6).toString())?'image/gif':data.subarray(0,4).toString()==='RIFF'&&data.subarray(8,12).toString()==='WEBP'?'image/webp':fallback;if(!accepted.includes(mime))return null;}return {data,mime};
  }return null;
 }
 const avatarBytes=url=>downloadCdn(url,2*1024*1024,['image/jpeg','image/png','image/gif','image/webp']);
 const cache=mediaCache({db,dataDir,encrypt,decrypt,validUrl:cdnUrl,resolveSource:async(source,a)=>{
  const c=get('SELECT channel_id FROM conversations WHERE id=?',a.conversation_id);
  if(source.provider!=='facebook_personal'||!c||c.channel_id!==source.channel_id||!providerMedia)problem(410,'Không xác định được kênh của tệp.');
  const result=await providerMedia(source.channel_id,source.descriptor);
  const data=result?.data;if(!Buffer.isBuffer(data)||!data.length||data.length>MAX_ATTACHMENT)problem(413,'Tệp vượt quá giới hạn xem trước.');
  const hex=data.subarray(0,12).toString('hex');let mime=hex.startsWith('89504e470d0a1a0a')?'image/png':hex.startsWith('ffd8ff')?'image/jpeg':/^GIF8[79]a/.test(data.subarray(0,6).toString())?'image/gif':data.subarray(0,4).toString()==='RIFF'&&data.subarray(8,12).toString()==='WEBP'?'image/webp':data.subarray(4,8).toString()==='ftyp'?(result.mime==='video/quicktime'?'video/quicktime':'video/mp4'):hex.startsWith('1a45dfa3')?'video/webm':'';
  if(!mime)problem(415,'Định dạng ảnh/video này chưa được hỗ trợ xem trực tiếp.');
  return {data,mime};
 },download:(url,a)=>downloadCdn(url,a.media_kind==='sticker'?2*1024*1024:MAX_ATTACHMENT,a.media_kind==='video'?['video/mp4','video/quicktime','video/webm']:['image','gif','sticker'].includes(a.media_kind)?['image/jpeg','image/png','image/gif','image/webp']:Object.values(formats).concat('application/octet-stream'),a.mime)});
 const meta=a=>cache.describe(a);
 async function cacheIncomingAttachment(channelId,peer,messageId,url,title,{imageOnly=false,kind='',mime='',urls=[]}={}){
  try{const source=cache.source([url,...urls]);if(!source)return false;
   const m=get('SELECT m.id,m.local_deleted,m.attachment_id,c.id conversation_id,c.hidden_local,ch.enabled FROM messages m JOIN conversations c ON c.id=m.conversation_id JOIN channels ch ON ch.id=c.channel_id WHERE c.channel_id=? AND c.external_id=? AND m.external_id=?',channelId,peer,messageId);
   if(!m||m.local_deleted||m.hidden_local||!m.enabled)return false;
   if(m.attachment_id){run('UPDATE attachments SET source=?,retry_at=0 WHERE id=?',source,m.attachment_id);return true;}
   const safe=cdnUrl(url),ext=(String(title||'').split('.').at(-1)||'').toLowerCase(),urlExt=new URL(safe).pathname.split('.').at(-1).toLowerCase();
   mime=Object.values(formats).includes(mime)?mime:formats[ext]||formats[urlExt]||(imageOnly?'image/png':'application/octet-stream');kind=kind|| (imageOnly?(String(title).includes('Sticker')?'sticker':'image'):mime.startsWith('video/')?'video':'file');
   let name=text(String(title||'Tệp đính kèm').replace(/[\\/\x00-\x1f]/g,'_'),180);if(!name)name='Tệp đính kèm';const id=randomUUID();
   run('INSERT INTO attachments(id,conversation_id,name,mime,size,data,created,message_id,source,media_kind) VALUES(?,?,?,?,?,?,?,?,?,?)',id,m.conversation_id,name,mime,0,Buffer.alloc(0),new Date().toISOString(),m.id,source,kind);
   run('UPDATE messages SET attachment_id=? WHERE id=?',id,m.id);return true;
  }catch{return false;}
 }
 async function cacheProviderAttachment(channelId,peer,messageId,descriptor){
  if(!descriptor?.encrypted||!['image','video'].includes(descriptor.kind)||!Number.isSafeInteger(descriptor.size)||descriptor.size<0||descriptor.size>MAX_ATTACHMENT||JSON.stringify(descriptor).length>32768)return false;
  const m=get('SELECT m.id,m.local_deleted,m.attachment_id,c.id conversation_id,c.hidden_local,ch.enabled,ch.provider FROM messages m JOIN conversations c ON c.id=m.conversation_id JOIN channels ch ON ch.id=c.channel_id WHERE c.channel_id=? AND c.external_id=? AND m.external_id=?',channelId,peer,messageId);
  if(!m||m.local_deleted||m.hidden_local||!m.enabled||m.provider!=='facebook_personal')return false;
  const source=encrypt({provider:'facebook_personal',channel_id:channelId,descriptor});
  const name=text(String(descriptor.name|| (descriptor.kind==='image'?'Ảnh Messenger.jpg':'Video Messenger.mp4')).replace(/[\\/\x00-\x1f]/g,'_'),180);
  const mime=descriptor.kind==='video'?'video/mp4':['image/jpeg','image/png','image/webp','image/gif'].includes(descriptor.mime)?descriptor.mime:'image/jpeg';
  if(m.attachment_id){run('UPDATE attachments SET source=?,retry_at=0 WHERE id=?',source,m.attachment_id);return true;}
  const id=randomUUID();run('INSERT INTO attachments(id,conversation_id,name,mime,size,data,created,message_id,source,media_kind) VALUES(?,?,?,?,?,?,?,?,?,?)',id,m.conversation_id,name,mime,descriptor.size,Buffer.alloc(0),new Date().toISOString(),m.id,source,descriptor.kind);
  run('UPDATE messages SET attachment_id=? WHERE id=?',id,m.id);return true;
 }
 const profiles=customerProfiles({db,decrypt,transport,avatarBytes,profileLink});
 const profile=(c,options)=>['zalo_personal','facebook_personal'].includes(get('SELECT provider FROM channels WHERE id=?',c.channel_id)?.provider)?personalProfile?.(c,options):profiles.profile(c,options);
 function state(u){const orders=all('SELECT o.*,c.channel_id,c.name conversation_name FROM orders o JOIN conversations c ON c.id=o.conversation_id ORDER BY o.id DESC').filter(o=>allowed(u,o.channel_id)).map(o=>({...o,items:JSON.parse(o.items)}));return {orders};}
 const attachmentsFor=id=>all('SELECT id,name,mime,size,media_kind,cache_disk,source,length(data)>0 has_data FROM attachments WHERE conversation_id=?',id).map(meta);
 function attachment(c,id){const a=get('SELECT * FROM attachments WHERE id=? AND conversation_id=?',id,c.id);if(!a||a.message_id)problem(400,'Tệp đã gửi hoặc không thuộc hội thoại này.');const data=cache.bytes(a);if(!data)problem(410,'Tệp chờ gửi không còn. Hãy chọn lại tệp.');return {...a,data};}
 async function sendAttachment(ch,c,a){const s=decrypt(ch.secret),kind=a.mime.startsWith('image/')?'image':a.mime.startsWith('video/')?'video':a.mime.startsWith('audio/')?'audio':'file';
  if(ch.provider==='facebook'){const form=new FormData();form.set('recipient',JSON.stringify({id:c.external_id}));form.set('messaging_type','RESPONSE');form.set('message',JSON.stringify({attachment:{type:kind,payload:{is_reusable:false}}}));form.set('filedata',new Blob([a.data],{type:a.mime}),a.name);return transport(`https://graph.facebook.com/${s.graph_version}/${ch.external_id}/messages`,{method:'POST',headers:{Authorization:'Bearer '+s.access_token},body:form});}
  const image=kind==='image',form=new FormData();form.set('file',new Blob([a.data],{type:a.mime}),a.name);const upload=await transport('https://openapi.zalo.me/v2.0/oa/upload/'+(image?'image':'file'),{method:'POST',headers:{access_token:s.access_token},body:form});const token=image?upload.data?.attachment_id:upload.data?.token;if(!token)throw Error('Upload chưa hoàn tất.');
  const message=image?{attachment:{type:'template',payload:{template_type:'media',elements:[{media_type:'image',attachment_id:token}]}}}:{attachment:{type:'file',payload:{token}}};return transport('https://openapi.zalo.me/v3.0/oa/message/cs',{method:'POST',headers:{'Content-Type':'application/json',access_token:s.access_token},body:JSON.stringify({recipient:{user_id:c.external_id},message})});
 }
 async function api({p,req,raw,body,u,send}){
  if(p==='/api/storage'){
   if(u.role!=='admin')problem(403,'Chỉ quản trị viên quản lý lưu trữ.');
   if(req.method==='GET')return send(200,cache.stats());
   if(req.method==='PATCH'){const result=cache.configure(body);audit(u,null,'Cập nhật giới hạn lưu tạm',body.days+' ngày');return send(200,result);}
   problem(405,'Thao tác không hỗ trợ.');
  }
  if(['/api/storage/cleanup','/api/storage/compact'].includes(p)&&req.method==='POST'){
   if(u.role!=='admin')problem(403,'Chỉ quản trị viên quản lý lưu trữ.');if(body.confirm!==true)problem(400,'Cần xác nhận thao tác.');
   const compact=p.endsWith('/compact');if(compact)cache.compact();else cache.cleanup();audit(u,null,compact?'Thu gọn cơ sở dữ liệu':'Dọn tệp lưu tạm');return send(200,cache.stats());
  }
  const author=p.match(/^\/api\/messages\/(\d+)\/avatar$/);
  if(author&&req.method==='GET'){
   const msg=get('SELECT * FROM messages WHERE id=? AND local_deleted=0',Number(author[1]));if(!msg)problem(404,'Không tìm thấy tin nhắn.');
   const c=conversation(u,msg.conversation_id),ch=get('SELECT provider FROM channels WHERE id=?',c.channel_id);
   if(ch.provider!=='zalo_personal'||c.thread_type!=='group'||!msg.author_id||!['incoming','outgoing'].includes(msg.kind))return send(404,{error:'Chưa có ảnh người gửi.'});
   const d=await personalAuthorAvatar?.(c,msg.author_id);if(!d?.avatar)return send(404,{error:'Chưa có ảnh người gửi.'});cache.cleanup();
   return send(200,Buffer.from(d.avatar),d.avatar_type,{'Cache-Control':'private, no-cache'});
  }
  let m=p.match(/^\/api\/conversations\/(\d+)\/(avatar|profile|profile-refresh|attachments|orders)$/);
  if(m){const c=conversation(u,Number(m[1])),action=m[2],ch=get('SELECT * FROM channels WHERE id=?',c.channel_id);
   if(action==='profile-refresh'&&req.method==='POST'){if(!allowed(u,c.channel_id,true)||u.role==='viewer')problem(403,'Bạn chỉ có quyền xem.');await profile(c,{force:true});return send(200,profiles.publicState(c.id));}
   if(action==='avatar'&&req.method==='GET'){await profile(c);const d=get('SELECT avatar,avatar_type FROM customer_profiles WHERE conversation_id=?',c.id);if(!d?.avatar)return send(404,{error:'Chưa có ảnh đại diện.'});cache.cleanup();return send(200,Buffer.from(d.avatar),d.avatar_type,{'Cache-Control':'private, no-cache'});}
   if(action==='profile'&&req.method==='PATCH'){if(!allowed(u,c.channel_id,true)||u.role==='viewer')problem(403,'Bạn chỉ có quyền xem.');const link=profileLink(body.profile_url,ch.provider);if(body.profile_url&&!link)problem(400,'Nhập link HTTPS trang cá nhân Facebook/Zalo hợp lệ.');run("INSERT INTO customer_profiles(conversation_id,profile_url,phone,address) VALUES(?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET profile_url=excluded.profile_url,link_source='manual',phone=excluded.phone,address=excluded.address",c.id,link,text(body.phone,40),text(body.address,500));audit(u,c.id,'Cập nhật hồ sơ khách hàng');return send(200,{ok:true});}
   if(action==='attachments'&&req.method==='POST'){
    if(!allowed(u,c.channel_id,true)||u.role==='viewer')problem(403,'Bạn chỉ có quyền xem.');if(c.kind==='comment')problem(400,'Tệp đính kèm dùng cho tin nhắn riêng.');if(!ch.enabled)problem(400,'Kênh đang tạm dừng.');
    let name;try{name=decodeURIComponent(req.headers['x-file-name']||'');}catch{problem(400,'Tên tệp không hợp lệ.');}name=text(name.replace(/[\\/\x00-\x1f]/g,'_'),180);const ext=name.split('.').at(-1)?.toLowerCase(),mime=formats[ext];if(!mime)problem(400,'Định dạng tệp chưa được hỗ trợ.');if(!raw.length||raw.length>MAX_ATTACHMENT)problem(413,'Tệp cần nhỏ hơn hoặc bằng 25 MB.');
    if(mime==='image/png'&&!raw.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))||mime==='image/jpeg'&&raw.subarray(0,3).toString('hex')!=='ffd8ff'||mime==='image/gif'&&!raw.subarray(0,6).toString().match(/^GIF8[79]a$/)||mime==='image/webp'&&(raw.subarray(0,4).toString()!=='RIFF'||raw.subarray(8,12).toString()!=='WEBP'))problem(400,'Nội dung ảnh không đúng định dạng.');
    if(ch.provider==='zalo'&&mime.startsWith('image/')&&(!['image/jpeg','image/png'].includes(mime)||raw.length>1024*1024))problem(400,'Zalo OA hỗ trợ ảnh JPG/PNG tối đa 1 MB.');
    if(ch.provider==='zalo'&&!mime.startsWith('image/')&&(!['pdf','doc','docx','csv'].includes(ext)||raw.length>5*1024*1024))problem(400,'Zalo OA hỗ trợ tệp PDF/DOC/DOCX/CSV tối đa 5 MB; chưa hỗ trợ gửi video qua chức năng này.');
    run('DELETE FROM attachments WHERE message_id IS NULL AND created<?',new Date(Date.now()-86400000).toISOString());if(get('SELECT COUNT(*) n FROM attachments WHERE conversation_id=? AND message_id IS NULL',c.id).n>=10)problem(400,'Có quá nhiều tệp chưa gửi. Hãy gửi hoặc bỏ tệp cũ.');
    const id=randomUUID();run('INSERT INTO attachments(id,conversation_id,name,mime,size,data,created) VALUES(?,?,?,?,?,?,?)',id,c.id,name,mime,raw.length,Buffer.alloc(0),new Date().toISOString());try{cache.put(id,raw);}catch(e){run('DELETE FROM attachments WHERE id=?',id);throw e;}return send(201,{id,name,mime,size:raw.length});
   }
   if(action==='orders'&&req.method==='POST'){
    if(!allowed(u,c.channel_id,true)||u.role==='viewer')problem(403,'Bạn chỉ có quyền xem.');const rid=text(body.request_id,80);if(!rid)problem(400,'Thiếu mã tạo đơn.');const old=get('SELECT id FROM orders WHERE conversation_id=? AND request_id=?',c.id,rid);if(old)return send(200,old);
    const customer=text(body.customer),phone=text(body.phone,40),address=text(body.address,500),items=body.items;
    if(!customer||!Array.isArray(items)||!items.length||items.length>30)problem(400,'Nhập người nhận và ít nhất một sản phẩm.');
    const money=n=>Number.isSafeInteger(n)&&n>=0&&n<=100000000000;
    for(const i of items)if(!i||typeof i!=='object'||!text(i.name)||!Number.isInteger(i.quantity)||i.quantity<1||i.quantity>10000||!money(i.price))problem(400,'Kiểm tra tên sản phẩm, số lượng và đơn giá.');
    const shipping=body.shipping??0,discount=body.discount??0;if(!money(shipping)||!money(discount))problem(400,'Phí vận chuyển hoặc giảm giá không hợp lệ.');const total=items.reduce((s,i)=>s+i.quantity*i.price,0)+shipping-discount;if(!money(total))problem(400,'Tổng đơn không hợp lệ.');const time=new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');try{const r=run('INSERT INTO orders(conversation_id,request_id,customer,phone,address,items,shipping,discount,total,note,created,updated,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',c.id,rid,customer,phone,address,JSON.stringify(items.map(i=>({name:text(i.name),quantity:i.quantity,price:i.price}))),shipping,discount,total,text(body.note,1000),time,time,u.id);const id=Number(r.lastInsertRowid);run("INSERT INTO messages(conversation_id,kind,body,sender_id,created,status,order_id) VALUES(?,'order',?,?,?,'internal',?)",c.id,'Đơn hàng CB'+String(id).padStart(6,'0'),u.id,time,id);run('UPDATE conversations SET version=version+1 WHERE id=?',c.id);audit(u,c.id,'Tạo đơn hàng','CB'+id);db.exec('COMMIT');return send(201,{id});}catch(e){db.exec('ROLLBACK');throw e;}
   }
   problem(405,'Thao tác không hỗ trợ.');
  }
  m=p.match(/^\/api\/attachments\/([a-f0-9-]+)(\/info)?$/);if(m){let a=get('SELECT * FROM attachments WHERE id=?',m[1]);if(!a)problem(404,'Không tìm thấy tệp.');const c=conversation(u,a.conversation_id);if(a.message_id&&get('SELECT local_deleted FROM messages WHERE id=?',a.message_id)?.local_deleted)problem(404,'Tệp đã xoá.');
   if(req.method==='DELETE'&&!m[2]){if(!allowed(u,c.channel_id,true)||a.message_id)problem(403,'Không thể bỏ tệp này.');cache.remove(a.id);run('DELETE FROM attachments WHERE id=?',a.id);return send(200,{ok:true});}
   if(req.method!=='GET')problem(405,'Thao tác không hỗ trợ.');a=await cache.load(a.id);
   conversation(u,a.conversation_id);if(m[2])return send(200,meta(a));
   const bytes=Buffer.from(a.data),headers={'Accept-Ranges':'bytes','Content-Length':String(bytes.length),'Content-Disposition':`${/^(image|video|audio)\//.test(a.mime)?'inline':'attachment'}; filename="attachment"; filename*=UTF-8''${encodeURIComponent(a.name)}`,'Content-Security-Policy':"default-src 'none'; sandbox"};
   if(req.headers.range&&!req.headers['if-range']){
    const range=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    const start=range?(range[1]?Number(range[1]):Math.max(0,bytes.length-Number(range[2]))):NaN;
    const end=range?(range[1]&&range[2]?Math.min(Number(range[2]),bytes.length-1):bytes.length-1):NaN;
    if(!range||(!range[1]&&!range[2])||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=bytes.length)
     return send(416,Buffer.alloc(0),a.mime,{'Accept-Ranges':'bytes','Content-Range':`bytes */${bytes.length}`,'Content-Length':'0'});
    const part=bytes.subarray(start,end+1);
    return send(206,part,a.mime,{...headers,'Content-Length':String(part.length),'Content-Range':`bytes ${start}-${end}/${bytes.length}`});
   }
   return send(200,bytes,a.mime,headers);
  }
  if(p==='/api/tags'&&req.method==='POST'){if(u.role==='viewer'||!all('SELECT id FROM channels').some(c=>allowed(u,c.id,true)))problem(403,'Bạn chỉ có quyền xem.');const name=text(body.name,32),color=String(body.color||'');if(!name||!/^#[a-f0-9]{6}$/i.test(color))problem(400,'Tên hoặc màu thẻ không hợp lệ.');run('INSERT INTO tag_colors(name,color) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET color=excluded.color',name,color);audit(u,null,'Đổi màu thẻ',name);return send(200,{ok:true});}
  m=p.match(/^\/api\/orders\/(\d+)$/);if(m&&req.method==='PATCH'){const o=get('SELECT * FROM orders WHERE id=?',Number(m[1]));if(!o)problem(404,'Không tìm thấy đơn.');const c=conversation(u,o.conversation_id,true);if(u.role==='viewer')problem(403,'Bạn chỉ có quyền xem.');if(!['new','confirmed','shipping','completed','cancelled'].includes(body.status))problem(400,'Trạng thái đơn không hợp lệ.');const r=run('UPDATE orders SET status=?,version=version+1,updated=? WHERE id=? AND version=?',body.status,new Date().toISOString(),o.id,Number(body.version));if(!r.changes)problem(409,'Đơn đã được cập nhật. Tải lại rồi thử.');audit(u,c.id,'Cập nhật đơn hàng','CB'+o.id+' '+body.status);return send(200,{ok:true});}
  return false;
 }
 return {api,cache,attachmentMeta:id=>{const a=get('SELECT id,name,mime,size,media_kind,cache_disk,source,length(data)>0 has_data FROM attachments WHERE id=?',id);return a?meta(a):null;},close:()=>cache.close(),profile,profileState:profiles.publicState,state,attachment,attachmentsFor,sendAttachment,avatarBytes,cacheIncomingAttachment,cacheProviderAttachment};
}
