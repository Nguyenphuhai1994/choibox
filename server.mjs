import {channelStatus} from './channel-status.mjs';
import {facebookPersonal} from './facebook-personal.mjs';
import {sharedFacebook} from "./shared-facebook.mjs";
import {facebookConnect} from './facebook-connect.mjs';
import {facebookHistory} from './facebook-history.mjs';
import {workspaceFeatures,MAX_ATTACHMENT} from './workspace-features.mjs';
import {zaloPersonal} from './zalo-personal.mjs';
import {providerFailure} from './customer-profile.mjs';
import http from 'node:http';
import networkConfig from './desktop/config.cjs';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual, createCipheriv, createDecipheriv, createHmac, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
process.umask(0o077);
const ROOT=path.dirname(fileURLToPath(import.meta.url));
const now=()=>new Date().toISOString();
const hash=s=>createHash('sha256').update(s).digest('hex');
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const clean=(v,max=200)=>String(v??'').trim().slice(0,max);
function password(p){const salt=randomBytes(16).toString('hex');return salt+':'+scryptSync(p,salt,64).toString('hex');}
function verify(p,h){const [salt,key]=h.split(':');return timingSafeEqual(scryptSync(p,salt,64),Buffer.from(key,'hex'));}
function validPassword(p){if(typeof p!=='string'||p.length<10||p.length>256)fail(400,'Mật khẩu cần từ 10 đến 256 ký tự.');}
const safeChannel=c=>{const {secret,...rest}=c;return {...rest,configured:!!secret};};
async function defaultTransport(url,options){const r=await fetch(url,{...options,signal:AbortSignal.timeout(options?.body instanceof FormData?60000:15000)});let d;try{d=await r.json();}catch{throw new Error('API trả về dữ liệu không hợp lệ');}if(!r.ok||d.error)throw providerFailure(d,r.status);return d;}
export function createApp({facebookFactory,facebookFlowMs,facebookRetryMs,zaloRecoveryOptions,zaloFactory,zaloFlowMs,zaloRetryMs,connectTransport,connectPollMs=5000,fetchImage,dataDir=process.env.DATA_DIR||path.join(ROOT,'data'),transport=defaultTransport,publicUrl=process.env.PUBLIC_URL||'',setupToken=process.env.SETUP_TOKEN||'',extraHosts=process.env.ALLOWED_HOSTS||''}={}){
 fs.mkdirSync(dataDir,{recursive:true,mode:0o700});fs.chmodSync(dataDir,0o700);
 const keyFile=path.join(dataDir,'secret.key');if(!fs.existsSync(keyFile))fs.writeFileSync(keyFile,randomBytes(32),{mode:0o600});
 const key=fs.readFileSync(keyFile);fs.chmodSync(keyFile,0o600);
 function encrypt(v){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);return JSON.stringify({iv:iv.toString('hex'),data:Buffer.concat([c.update(JSON.stringify(v)),c.final()]).toString('hex'),tag:c.getAuthTag().toString('hex')});}
 function decrypt(v){const x=JSON.parse(v),c=createDecipheriv('aes-256-gcm',key,Buffer.from(x.iv,'hex'));c.setAuthTag(Buffer.from(x.tag,'hex'));return JSON.parse(Buffer.concat([c.update(Buffer.from(x.data,'hex')),c.final()]).toString());}
 const freshDb=!fs.existsSync(path.join(dataDir,'inbox.sqlite'));const db=new DatabaseSync(path.join(dataDir,'inbox.sqlite'));if(freshDb)db.exec('PRAGMA auto_vacuum=INCREMENTAL');fs.chmodSync(path.join(dataDir,'inbox.sqlite'),0o600);
 db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,password TEXT NOT NULL,role TEXT NOT NULL,active INTEGER DEFAULT 1);
 CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id INTEGER REFERENCES users(id),csrf TEXT,expires INTEGER);
 CREATE TABLE IF NOT EXISTS channels(id INTEGER PRIMARY KEY,name TEXT NOT NULL,provider TEXT NOT NULL,external_id TEXT NOT NULL,secret TEXT,mode TEXT DEFAULT 'live',enabled INTEGER DEFAULT 1,last_event TEXT,last_checked TEXT,health TEXT DEFAULT 'Chưa kiểm tra',verified INTEGER DEFAULT 0,UNIQUE(provider,external_id));
 CREATE TABLE IF NOT EXISTS grants(user_id INTEGER REFERENCES users(id),channel_id INTEGER REFERENCES channels(id),can_reply INTEGER DEFAULT 0,PRIMARY KEY(user_id,channel_id));
 CREATE TABLE IF NOT EXISTS conversations(id INTEGER PRIMARY KEY,channel_id INTEGER REFERENCES channels(id),external_id TEXT NOT NULL,name TEXT NOT NULL,status TEXT DEFAULT 'open',assignee INTEGER REFERENCES users(id),tags TEXT DEFAULT '[]',priority TEXT DEFAULT 'normal',unread INTEGER DEFAULT 0,updated TEXT,version INTEGER DEFAULT 1,UNIQUE(channel_id,external_id));
 CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY,conversation_id INTEGER REFERENCES conversations(id),external_id TEXT,request_id TEXT,kind TEXT,body TEXT,sender_id INTEGER REFERENCES users(id),created TEXT,status TEXT,error TEXT,UNIQUE(conversation_id,external_id),UNIQUE(conversation_id,request_id));
 CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,user_id INTEGER,conversation_id INTEGER,action TEXT,detail TEXT,created TEXT);
 CREATE TABLE IF NOT EXISTS replies(id INTEGER PRIMARY KEY,title TEXT,body TEXT);
 CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id,id);
 CREATE INDEX IF NOT EXISTS conversations_updated ON conversations(updated);`);
 if(!db.prepare('PRAGMA table_info(channels)').all().some(c=>c.name==='verified'))db.exec('ALTER TABLE channels ADD COLUMN verified INTEGER DEFAULT 0');
 for(const [name,definition] of [['kind',"TEXT DEFAULT 'chat'"],['post_id','TEXT'],['comment_id','TEXT'],['deleted','INTEGER DEFAULT 0']]){
  if(!db.prepare('PRAGMA table_info(conversations)').all().some(c=>c.name===name))db.exec(`ALTER TABLE conversations ADD COLUMN ${name} ${definition}`);
 }
 db.exec(`CREATE TABLE IF NOT EXISTS facebook_comments(channel_id INTEGER REFERENCES channels(id),external_id TEXT,conversation_id INTEGER REFERENCES conversations(id),event_time INTEGER DEFAULT 0,deleted INTEGER DEFAULT 0,PRIMARY KEY(channel_id,external_id));`);
 if(!db.prepare('PRAGMA table_info(messages)').all().some(c=>c.name==='author_name'))db.exec('ALTER TABLE messages ADD COLUMN author_name TEXT');
 for(const name of ['local_deleted','hidden'])if(!db.prepare('PRAGMA table_info(messages)').all().some(c=>c.name===name))db.exec(`ALTER TABLE messages ADD COLUMN ${name} INTEGER DEFAULT 0`);
 db.exec("CREATE UNIQUE INDEX IF NOT EXISTS single_workspace_admin ON users(role) WHERE role='admin'");
 const get=(sql,...p)=>db.prepare(sql).get(...p),all=(sql,...p)=>db.prepare(sql).all(...p),run=(sql,...p)=>db.prepare(sql).run(...p);
 for(const [name,type] of [['hidden_local','INTEGER DEFAULT 0'],['deleted_before','TEXT']])if(!all('PRAGMA table_info(conversations)').some(c=>c.name===name))db.exec(`ALTER TABLE conversations ADD COLUMN ${name} ${type}`);
 const originalTransport=transport;
 transport=(url,options={})=>{
  const target=new URL(url);
  if(target.origin==='https://graph.facebook.com'){
   const token=options.headers?.Authorization?.replace(/^Bearer /,'');
   if(token)for(const c of all("SELECT secret FROM channels WHERE provider='facebook' AND secret IS NOT NULL")){const secret=decrypt(c.secret);if(secret.shared&&secret.access_token===token){target.searchParams.set('appsecret_proof',secret.appsecret_proof);break;}}
  }
  return originalTransport(target.href,options);
 };
 let appClosing=false;
 const history=facebookHistory({db,decrypt,transport});
 async function checkAuthChannel(c){
  let health='Kênh thử nghiệm',verified=0;
  if(c.mode==='live'){
   if(!c.secret)return {health:'Chưa có thông tin kết nối.'};
   try{
    const s=decrypt(c.secret);
    const d=c.provider==='facebook'?await transport('https://graph.facebook.com/'+s.graph_version+'/'+c.external_id+'?fields=id,name',{headers:{Authorization:'Bearer '+s.access_token}}):await transport('https://openapi.zalo.me/v2.0/oa/getoa',{headers:{access_token:s.access_token}});
    const actual=d.id||d.data?.oa_id||d.data?.id;if(String(actual)!==c.external_id)throw Error();
    health='Token hợp lệ';verified=1;
   }catch{health='Quyền kết nối không hợp lệ. Cần kết nối lại.';}
  }
  if(appClosing)return {health};
  const current=get('SELECT secret,enabled FROM channels WHERE id=?',c.id);
  if(current?.secret===c.secret)run('UPDATE channels SET last_checked=?,health=?,verified=? WHERE id=?',now(),health,verified,c.id);
  return {health};
 }
 let checkingChannels=false;
 const channelHeartbeat=setInterval(async()=>{
  if(appClosing||checkingChannels)return;checkingChannels=true;
  try{
   const rows=all("SELECT * FROM channels WHERE provider IN ('facebook','zalo') AND enabled=1 AND mode='live' AND secret IS NOT NULL");
   let index=0;await Promise.all([0,1].map(async()=>{while(!appClosing&&index<rows.length){const c=rows[index++];await checkAuthChannel(c);}}));
  }catch{/* A later round retries without interrupting message reception. */}
  finally{checkingChannels=false;}
 },300000);channelHeartbeat.unref?.();
 function tx(f){db.exec('BEGIN IMMEDIATE');try{const r=f();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}
 function audit(u,c,a,d=''){run('INSERT INTO audit(user_id,conversation_id,action,detail,created) VALUES(?,?,?,?,?)',u?.id??null,c??null,a,clean(d,500),now());}
 function allowed(u,c,reply=false){if(u.role==='admin')return true;const g=get('SELECT * FROM grants WHERE user_id=? AND channel_id=?',u.id,c);return !!g&&(!reply||(g.can_reply&&u.role!=='viewer'));}
 function conversation(u,id,reply=false){const c=get('SELECT * FROM conversations WHERE id=?',id);if(!c||!allowed(u,c.channel_id,reply))fail(403,'Bạn không có quyền với hội thoại này.');return c;}
 function admin(u){if(u.role!=='admin')fail(403,'Chỉ quản trị viên được thao tác.');}
 let personal,fbPersonal;
 const features=workspaceFeatures({db,dataDir,encrypt,decrypt,transport,allowed,conversation,audit,fetchImage,personalProfile:(c,o)=>get("SELECT provider FROM channels WHERE id=?",c.channel_id)?.provider==="facebook_personal"?fbPersonal?.profile(c,o):personal?.profile(c,o),personalAuthorAvatar:(c,id)=>personal?.authorAvatar(c,id),providerMedia:(channelId,descriptor)=>fbPersonal?.downloadMedia(channelId,descriptor)});
 personal=zaloPersonal({db,encrypt,decrypt,ingest,avatarBytes:features.avatarBytes,cacheIncomingAttachment:features.cacheIncomingAttachment,factory:zaloFactory,flowMs:zaloFlowMs,retryMs:zaloRetryMs,recoveryOptions:zaloRecoveryOptions});
 fbPersonal=facebookPersonal({db,dataDir,encrypt,decrypt,ingest,avatarBytes:features.avatarBytes,cacheIncomingAttachment:features.cacheIncomingAttachment,cacheProviderAttachment:features.cacheProviderAttachment,factory:facebookFactory,flowMs:facebookFlowMs,retryMs:facebookRetryMs});
 function ingest(channel,external,name,messageId,body,created=now(),kind='incoming'){
  tx(()=>{let c=get('SELECT * FROM conversations WHERE channel_id=? AND external_id=?',channel.id,external);
   if(!c){const r=run('INSERT INTO conversations(channel_id,external_id,name,updated) VALUES(?,?,?,?)',channel.id,external,name||external,created);c=get('SELECT * FROM conversations WHERE id=?',r.lastInsertRowid);}
   if(get('SELECT id FROM messages WHERE conversation_id=? AND external_id=?',c.id,messageId))return;
   if(c.deleted_before&&created<=c.deleted_before)return;
   if(kind==='incoming')run('UPDATE conversations SET hidden_local=0 WHERE id=?',c.id);
   run('INSERT INTO messages(conversation_id,external_id,kind,body,created,status) VALUES(?,?,?,?,?,?)',c.id,messageId,kind,clean(body,12000),created,kind==='incoming'?'received':'sent');
   run("UPDATE conversations SET unread=unread+?,status=CASE WHEN ?='incoming' THEN 'open' ELSE status END,updated=?,version=version+1 WHERE id=?",kind==='incoming'?1:0,kind,created,c.id);
   run('UPDATE channels SET last_event=?,health=? WHERE id=?',now(),'Đã nhận sự kiện',channel.id);
  });
 }
 function ingestComment(channel,value,eventTime){
  const id=String(value.comment_id||''),post=String(value.post_id||''),parent=String(value.parent_id||post);
  if(value.item!=='comment'||!/^\d+(?:_\d+)*$/.test(id)||!/^\d+(?:_\d+)*$/.test(post)||!['add','edited','remove'].includes(value.verb))return;
  const previous=get('SELECT * FROM facebook_comments WHERE channel_id=? AND external_id=?',channel.id,id);
  const time=Number(eventTime)||Math.floor(Date.now()/1000);
  if(previous&&(time<previous.event_time||previous.deleted&&value.verb!=='remove'))return;
  const existingMessage=get("SELECT m.*,c.comment_id FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.channel_id=? AND c.kind='comment' AND m.external_id=?",channel.id,id);
  if(value.verb==='remove'){
   if(existingMessage){run("UPDATE messages SET body='[Bình luận đã bị xóa]',status='deleted' WHERE id=?",existingMessage.id);if(existingMessage.comment_id===id)run('UPDATE conversations SET deleted=1,version=version+1 WHERE id=?',existingMessage.conversation_id);}
   run('INSERT INTO facebook_comments(channel_id,external_id,conversation_id,event_time,deleted) VALUES(?,?,?,?,1) ON CONFLICT(channel_id,external_id) DO UPDATE SET event_time=excluded.event_time,deleted=1',channel.id,id,existingMessage?.conversation_id||null,time);return;
  }
  if(existingMessage&&existingMessage.comment_id===id&&/^\d+$/.test(String(value.from?.id||''))&&String(value.from.id)!==channel.external_id)run('UPDATE conversations SET contact_id=? WHERE id=?',String(value.from.id),existingMessage.conversation_id);
  if(existingMessage){if(value.verb==='edited'&&!existingMessage.local_deleted)run('UPDATE messages SET body=? WHERE id=?',clean(value.message||'[Bình luận đính kèm]',12000),existingMessage.id);run('UPDATE facebook_comments SET event_time=? WHERE channel_id=? AND external_id=?',time,channel.id,id);return;}
  const root=parent&&parent!==post?parent:id;
  const rootDeleted=get('SELECT deleted FROM facebook_comments WHERE channel_id=? AND external_id=?',channel.id,root)?.deleted||0;
  const outgoing=String(value.from?.id)===channel.external_id;
  ingest(channel,'comment:'+root,value.from?.name||'Bình luận Facebook',id,value.message||'[Bình luận đính kèm]',new Date(time*1000).toISOString(),outgoing?'outgoing':'incoming');
  const co=get('SELECT id FROM conversations WHERE channel_id=? AND external_id=?',channel.id,'comment:'+root);
  run("UPDATE conversations SET kind='comment',post_id=?,comment_id=?,deleted=? WHERE id=?",post,root,rootDeleted,co.id);
  if(id===root&&!outgoing)run('UPDATE conversations SET contact_id=? WHERE id=?',String(value.from?.id||''),co.id);
  run('UPDATE messages SET author_name=? WHERE conversation_id=? AND external_id=?',clean(value.from?.name|| (outgoing?channel.name:'Khách hàng')),co.id,id);
  run('INSERT INTO facebook_comments(channel_id,external_id,conversation_id,event_time) VALUES(?,?,?,?) ON CONFLICT(channel_id,external_id) DO UPDATE SET conversation_id=excluded.conversation_id,event_time=excluded.event_time',channel.id,id,co.id,time);
 }
 function ingestFacebookEntry(c,entry){if(String(entry.id)!==c.external_id)return;for(const change of entry.changes||[])if(change.field==='feed')ingestComment(c,change.value||{},entry.time);for(const e of entry.messaging||[]){
       if(e.message?.mid){const echo=!!e.message.is_echo,uid=String(echo?e.recipient?.id:e.sender?.id);if(!uid||uid==='undefined')continue;ingest(c,uid,uid,e.message.mid,e.message.text||'[Tin đính kèm: '+(e.message.attachments?.[0]?.type||'khác')+']',new Date(e.timestamp||Date.now()).toISOString(),echo?'outgoing':'incoming');const a=e.message.attachments?.[0];if(a?.payload?.url)void features.cacheIncomingAttachment(c.id,uid,e.message.mid,a.payload.url,'Tệp Facebook',{kind:a.type==='image'?'image':a.type==='video'?'video':'file'});}
       if(e.read?.watermark){const co=get('SELECT id FROM conversations WHERE channel_id=? AND external_id=?',c.id,String(e.sender?.id));if(co)run("UPDATE messages SET status='read' WHERE conversation_id=? AND kind='outgoing' AND status='sent' AND created<=?",co.id,new Date(e.read.watermark).toISOString());}
      }
 }
 const moderationBusy=new Set();
 const facebook=facebookConnect({db,encrypt,decrypt,transport,getPublicUrl:()=>publicUrl});
 const shared=sharedFacebook({dataDir,db,encrypt,decrypt,ingestEntry:ingestFacebookEntry,fetcher:connectTransport,pollMs:connectPollMs});
 const attempts=new Map();
 const server=http.createServer(async(req,res)=>{
  let secure=publicUrl.startsWith('https://');
  function send(code,data,type='application/json; charset=utf-8',extra={}){if(res.headersSent)return;res.writeHead(code,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',...extra});res.end(type.startsWith('application/json')?JSON.stringify(data):data);}
  try{
   const url=new URL(req.url,'http://localhost'),p=url.pathname;
   const upload=/^\/api\/conversations\/\d+\/attachments$/.test(p)&&req.method==='POST';
   if(upload){const token=(req.headers.cookie||'').match(/(?:^|;\s*)session=([a-f0-9]+)/)?.[1],session=token&&get('SELECT * FROM sessions WHERE token=? AND expires>?',hash(token),Date.now());const u=session&&get('SELECT * FROM users WHERE id=? AND active=1',session.user_id);if(!u)fail(401,'Vui lòng đăng nhập.');if(req.headers['x-csrf-token']!==session.csrf)fail(403,'Phiên không hợp lệ.');conversation(u,Number(p.split('/')[3]),true);}
   let raw=Buffer.alloc(0);if(req.method!=='GET'){const parts=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>(upload?MAX_ATTACHMENT:1024*1024))fail(413,'Dữ liệu quá lớn.');parts.push(chunk);}raw=Buffer.concat(parts);}
   let body={};if(raw.length&&!upload){try{body=JSON.parse(raw);}catch{fail(400,'JSON không hợp lệ.');}}
   if(p==='/oauth/facebook/callback'&&req.method==='GET')return await facebook.callback(url,send);
   const hm=p.match(/^\/webhooks\/(facebook|zalo)(?:\/(\d+))?$/);
   if(hm){
    const targets=all("SELECT * FROM channels WHERE provider=? AND enabled=1 AND mode='live'",hm[1]).filter(c=>c.secret&&(!hm[2]||c.id===Number(hm[2])));

    if(req.method==='GET'&&hm[1]==='facebook'){
     const valid=facebook.verify(url.searchParams.get('hub.verify_token'))||targets.some(c=>decrypt(c.secret).verify_token===url.searchParams.get('hub.verify_token'));
     if(url.searchParams.get('hub.mode')!=='subscribe'||!valid)fail(403,'Verify token không hợp lệ.');return send(200,url.searchParams.get('hub.challenge')||'','text/plain');
    }
    if(!targets.length)fail(404,'Kênh chưa cấu hình.');
    if(req.method!=='POST')fail(405,'Method không hỗ trợ.');
    const verifiedTargets=targets.filter(c=>{
     const s=decrypt(c.secret);if(s.shared)return false;let expected,actual;
     if(c.provider==='facebook'){expected='sha256='+createHmac('sha256',s.app_secret).update(raw).digest('hex');actual=req.headers['x-hub-signature-256']||'';}
     else {if(String(body.app_id)!==s.app_id)return false;expected='mac='+hash(s.app_id+raw.toString()+String(body.timestamp)+s.app_secret);actual=req.headers['x-zevent-signature']||'';}
     return expected.length===actual.length&&timingSafeEqual(Buffer.from(expected),Buffer.from(actual));
    });
    if(!verifiedTargets.length)fail(403,'Chữ ký webhook không hợp lệ.');
    for(const c of verifiedTargets){
     if(c.provider==='facebook'){
      for(const entry of body.entry||[])ingestFacebookEntry(c,entry);
     }else if(String(body.recipient?.id)===c.external_id&&body.event_name?.startsWith('user_send_')&&body.message?.msg_id){
      ingest(c,String(body.sender.id),body.sender.name||String(body.sender.id),String(body.message.msg_id),body.message.text||'[Tin đính kèm: '+body.event_name+']',new Date(Number(body.timestamp)||Date.now()).toISOString());const a=body.message.attachments?.[0],link=a?.payload?.url||a?.payload?.thumbnail;if(link)void features.cacheIncomingAttachment(c.id,String(body.sender.id),String(body.message.msg_id),link,'Tệp Zalo OA',{kind:body.event_name.includes('image')?'image':body.event_name.includes('video')?'video':'file'});
     }
    }
    return send(200,{ok:true});
   }
   const localHost=new URL('http://'+(req.headers.host||'')).hostname;
   const allowedHosts=networkConfig.allowedHosts(extraHosts+(publicUrl?','+new URL(publicUrl).hostname:''));
   if(!allowedHosts.includes(localHost))fail(403,'Địa chỉ truy cập không được cho phép.');
   if(p==='/api/health'&&req.method==='GET')return send(200,{app:'Choibox',version:'1.13.1'});
   if(p==='/api/bootstrap'&&req.method==='GET')return send(200,{setup:!get('SELECT id FROM users LIMIT 1'),requires_setup_token:!!setupToken});
   const origin=req.headers.origin;if(origin){const o=new URL(origin);if(o.host!==req.headers.host||!['http:','https:'].includes(o.protocol))fail(403,'Nguồn yêu cầu không hợp lệ.');secure=secure||o.protocol==='https:';}
   if(p==='/api/setup'&&req.method==='POST'){
    if(get('SELECT id FROM users LIMIT 1'))fail(409,'Đã có tài khoản quản trị.');if(!setupToken&&!['localhost','127.0.0.1','[::1]'].includes(localHost))fail(403,'Tạo quản trị viên lần đầu trực tiếp trên máy chủ.');if(setupToken&&(!body.setup_token||!timingSafeEqual(Buffer.from(hash(String(body.setup_token))),Buffer.from(hash(setupToken)))))fail(403,'Khóa khởi tạo máy chủ không đúng.');validPassword(body.password);
    const email=clean(body.email).toLowerCase(),name=clean(body.name);if(!email.includes('@')||!name)fail(400,'Nhập tên và email hợp lệ.');
    tx(()=>{if(get('SELECT id FROM users LIMIT 1'))fail(409,'Đã khởi tạo.');run('INSERT INTO users(name,email,password,role) VALUES(?,?,?,?)',name,email,password(body.password),'admin');});return send(201,{ok:true});
   }
   if(p==='/api/login'&&req.method==='POST'){
    const isLocalProxy=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);const ip=publicUrl&&isLocalProxy&&req.headers['cf-connecting-ip']?clean(req.headers['cf-connecting-ip'],80):req.socket.remoteAddress;const a=attempts.get(ip)||{n:0,time:Date.now()};if(Date.now()-a.time>600000){a.n=0;a.time=Date.now();}if(a.n>=15)fail(429,'Thử lại sau 10 phút.');a.n++;attempts.set(ip,a);
    const u=get('SELECT * FROM users WHERE email=? AND active=1',clean(body.email).toLowerCase());if(!u||!verify(body.password||'',u.password))fail(401,'Email hoặc mật khẩu không đúng.');attempts.delete(ip);
    const token=randomBytes(32).toString('hex'),csrf=randomBytes(24).toString('hex');run('DELETE FROM sessions WHERE expires<?',Date.now());run('INSERT INTO sessions VALUES(?,?,?,?)',hash(token),u.id,csrf,Date.now()+86400000);audit(u,null,'Đăng nhập');
    return send(200,{ok:true},undefined,{'Set-Cookie':`session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${secure?'; Secure':''}`});
   }
   if(p.startsWith('/api/')){
    const token=(req.headers.cookie||'').match(/(?:^|;\s*)session=([a-f0-9]+)/)?.[1];const session=token&&get('SELECT * FROM sessions WHERE token=? AND expires>?',hash(token),Date.now());
    const u=session&&get('SELECT id,name,email,role,active FROM users WHERE id=? AND active=1',session.user_id);if(!u)fail(401,'Vui lòng đăng nhập.');
    if(req.method!=='GET'&&req.headers['x-csrf-token']!==session.csrf)fail(403,'Phiên không hợp lệ, hãy tải lại trang.');
    if(await fbPersonal.api({p,req,body,u,session,send,audit}))return;
    if(await personal.api({p,req,body,u,session,send,audit}))return;
    if(await features.api({p,req,raw,body,u,send:(...args)=>{send(...args);return true;}}))return;
    if(await (shared||facebook).api({p,req,body,u,session,send,audit}))return;
    if(p==='/api/me')return send(200,{user:u,csrf:session.csrf});
    if(p==='/api/logout'&&req.method==='POST'){personal.cancelSession(session);fbPersonal.cancelSession(session);run('DELETE FROM sessions WHERE token=?',session.token);return send(200,{ok:true},undefined,{'Set-Cookie':'session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});}
    if(p==='/api/password'&&req.method==='POST'){validPassword(body.password);const old=get('SELECT password FROM users WHERE id=?',u.id);if(!verify(body.current||'',old.password))fail(400,'Mật khẩu hiện tại không đúng.');run('UPDATE users SET password=? WHERE id=?',password(body.password),u.id);run('DELETE FROM sessions WHERE user_id=? AND token<>?',u.id,session.token);audit(u,null,'Đổi mật khẩu');return send(200,{ok:true});}
    if(p==='/api/state'&&req.method==='GET'){
     const channels=all('SELECT * FROM channels').filter(c=>allowed(u,c.id)).map(c=>({...safeChannel(c),connection:channelStatus(c,{runtime:c.provider==='facebook_personal'?fbPersonal.connectionState(c.id):c.provider==='zalo_personal'?personal.connectionState(c.id):null}),...(c.provider==='zalo_personal'?{recovery:personal.syncState(c.id)}:{}),can_reply:allowed(u,c.id,true)}));const ids=new Set(channels.map(c=>c.id));
     const conv=all('SELECT c.*,ch.name channel_name,ch.provider,ch.mode,u.name assignee_name FROM conversations c JOIN channels ch ON ch.id=c.channel_id LEFT JOIN users u ON u.id=c.assignee WHERE c.hidden_local=0 ORDER BY updated DESC').filter(c=>ids.has(c.channel_id));
     const names=new Set(conv.flatMap(c=>JSON.parse(c.tags)));return send(200,{...features.state(u),tag_colors:all('SELECT * FROM tag_colors').filter(t=>names.has(t.name)),channels,conversations:conv.map(c=>{const profile=features.profileState(c.id);return {...c,...profile,tags:JSON.parse(c.tags),preview:get("SELECT body FROM messages WHERE conversation_id=? AND kind NOT IN ('note','order') AND local_deleted=0 ORDER BY created DESC,id DESC LIMIT 1",c.id)?.body||''};}),users:all('SELECT id,name,role FROM users WHERE active=1'),replies:all('SELECT * FROM replies ORDER BY id')});
    }
    const moderation=p.match(/^\/api\/messages\/(\d+)\/moderate$/);
    if(moderation&&req.method==='POST'){
     const msg=get('SELECT * FROM messages WHERE id=?',Number(moderation[1]));if(!msg)fail(404,'Không tìm thấy nội dung.');
     const co=conversation(u,msg.conversation_id,true),ch=get('SELECT * FROM channels WHERE id=?',co.channel_id),action=body.action;
     if(!['local-delete','delete','hide','unhide'].includes(action))fail(400,'Thao tác không hợp lệ.');
     if(moderationBusy.has(msg.id)||msg.status==='sending')fail(409,'Nội dung đang được xử lý. Thử lại sau.');
     if(action==='local-delete'){
      if(body.confirm!==true)fail(400,'Cần xác nhận xoá nội dung khỏi Choibox.');
      if(co.kind==='comment'&&msg.kind!=='note'&&msg.external_id)fail(400,'Bình luận Facebook cần dùng thao tác xoá bình luận.');
      run('DELETE FROM attachments WHERE message_id=?',msg.id);run("UPDATE messages SET local_deleted=1,body='',error=NULL,attachment_id=NULL WHERE id=?",msg.id);run('UPDATE conversations SET version=version+1 WHERE id=?',co.id);audit(u,co.id,'Xoá nội dung khỏi Choibox',String(msg.id));return send(200,{ok:true});
     }
     if(co.kind!=='comment'||ch.provider!=='facebook'||msg.kind==='note'||!msg.external_id||!/^\d+(?:_\d+)*$/.test(msg.external_id))fail(400,'Nội dung này không phải bình luận Facebook có thể quản lý.');
     if(!ch.enabled)fail(400,'Kênh đang tạm dừng.');if(ch.mode==='live'&&!ch.verified)fail(400,'Cần kết nối lại Page trước khi quản lý bình luận.');
     if(action==='delete'&&body.confirm!==true)fail(400,'Cần xác nhận xoá bình luận trên Facebook.');
     if(msg.status==='deleted'){if(action==='delete')return send(200,{ok:true});fail(409,'Bình luận đã bị xoá.');}
     moderationBusy.add(msg.id);
     try{
      if(ch.mode==='live'){
       const secret=decrypt(ch.secret);let result;
       try{result=await transport(`https://graph.facebook.com/${secret.graph_version}/${encodeURIComponent(msg.external_id)}`,{method:action==='delete'?'DELETE':'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+secret.access_token},...(action==='delete'?{}:{body:JSON.stringify({is_hidden:action==='hide'})})});}catch{fail(502,'Facebook chưa xác nhận thao tác. Kiểm tra quyền Page và nội dung trên Facebook trước khi thử lại.');}
       if(result!==true&&result?.success!==true)fail(502,'Facebook chưa xác nhận thao tác.');
      }
      tx(()=>{
       if(action==='delete'){
        run("UPDATE messages SET body='[Bình luận đã bị xoá]',status='deleted',hidden=0,error=NULL WHERE id=?",msg.id);
        run('INSERT INTO facebook_comments(channel_id,external_id,conversation_id,event_time,deleted) VALUES(?,?,?,?,1) ON CONFLICT(channel_id,external_id) DO UPDATE SET deleted=1,event_time=excluded.event_time',ch.id,msg.external_id,co.id,Math.floor(Date.now()/1000));
        if(co.comment_id===msg.external_id)run('UPDATE conversations SET deleted=1 WHERE id=?',co.id);
       }else run('UPDATE messages SET hidden=? WHERE id=?',action==='hide'?1:0,msg.id);
       run('UPDATE conversations SET version=version+1 WHERE id=?',co.id);audit(u,co.id,action==='delete'?'Xoá bình luận Facebook':action==='hide'?'Ẩn bình luận Facebook':'Hiện bình luận Facebook',msg.external_id);
      });return send(200,{ok:true});
     }finally{moderationBusy.delete(msg.id);}
    }
    let m=p.match(/^\/api\/conversations\/(\d+)(?:\/(messages|read|send|notes|audit|history))?$/);
    if(m){const id=Number(m[1]),action=m[2];const c=conversation(u,id,['send','notes'].includes(action));
     if(action==='messages'&&req.method==='GET'){await history.profile(c);void features.profile(c);return send(200,all('SELECT m.*,u.name sender_name FROM messages m LEFT JOIN users u ON u.id=m.sender_id WHERE conversation_id=? AND local_deleted=0 ORDER BY m.created,m.id',id).map(m=>({...m,attachment:m.attachment_id?features.attachmentMeta(m.attachment_id):null})));}
     if(action==='history'&&req.method==='POST'){if(!allowed(u,c.channel_id,true)||u.role==='viewer')fail(403,'Bạn chỉ có quyền xem.');try{return send(200,await history.sync(get('SELECT * FROM channels WHERE id=?',c.channel_id),c));}catch(e){fail(502,e.message);}}
     if(!action&&req.method==='DELETE'){if(!allowed(u,c.channel_id,true)||u.role==='viewer')fail(403,'Bạn chỉ có quyền xem.');if(c.kind==='comment')fail(400,'Chỉ xoá cuộc chat tại đây.');if(body.confirm!==true)fail(400,'Cần xác nhận xoá hội thoại.');if(history.busy.has(c.channel_id)||get("SELECT id FROM messages WHERE conversation_id=? AND status='sending'",id))fail(409,'Đang gửi hoặc đồng bộ. Vui lòng chờ.');tx(()=>{run('DELETE FROM attachments WHERE conversation_id=?',id);run("UPDATE messages SET local_deleted=1,body='',error=NULL,attachment_id=NULL WHERE conversation_id=?",id);run('UPDATE conversations SET hidden_local=1,deleted_before=?,unread=0,version=version+1 WHERE id=?',now(),id);audit(u,id,'Xoá hội thoại khỏi Choibox');});return send(200,{ok:true});}
     if(action==='audit'&&req.method==='GET')return send(200,all('SELECT a.*,u.name user_name FROM audit a LEFT JOIN users u ON u.id=a.user_id WHERE conversation_id=? ORDER BY id DESC LIMIT 100',id));
     if(action==='read'&&req.method==='POST'){if(u.role!=='viewer')run('UPDATE conversations SET unread=0 WHERE id=?',id);return send(200,{ok:true});}
     if(!action&&req.method==='PATCH'){
      if(u.role==='viewer'||!allowed(u,c.channel_id,true))fail(403,'Bạn chỉ có quyền xem.');if(Number(body.version)!==c.version)fail(409,'Hội thoại vừa được cập nhật. Tải lại rồi thử tiếp.');
      const status=body.status??c.status,priority=body.priority??c.priority,tags=body.tags??JSON.parse(c.tags),assignee=body.assignee===undefined?c.assignee:body.assignee;
      if(!['open','pending','closed'].includes(status)||!['normal','high'].includes(priority)||!Array.isArray(tags)||tags.length>10)fail(400,'Trạng thái hoặc thẻ không hợp lệ.');
      if(assignee!==c.assignee){if(!['admin','manager'].includes(u.role)&&!(c.assignee===null&&assignee===u.id))fail(403,'Bạn chỉ có thể nhận hội thoại chưa được giao.');if(assignee!==null){const target=get('SELECT * FROM users WHERE id=? AND active=1',assignee);if(!target||!allowed(target,c.channel_id,true))fail(400,'Nhân viên chưa được cấp quyền trả lời kênh này.');}}
      run('UPDATE conversations SET status=?,priority=?,tags=?,assignee=?,version=version+1 WHERE id=?',status,priority,JSON.stringify(tags.map(t=>clean(t,32)).filter(Boolean)),assignee,id);audit(u,id,'Cập nhật hội thoại',JSON.stringify({status,priority,tags,assignee}));return send(200,{ok:true});
     }
     if(action==='notes'&&req.method==='POST'){const text=clean(body.text,5000);if(!text)fail(400,'Ghi chú trống.');run("INSERT INTO messages(conversation_id,kind,body,sender_id,created,status) VALUES(?,'note',?,?,?,'internal')",id,text,u.id,now());audit(u,id,'Thêm ghi chú');return send(201,{ok:true});}
     if(action==='send'&&req.method==='POST'){
      if(c.kind==='comment'&&c.deleted)fail(400,'Bình luận gốc đã bị xóa, không thể trả lời.');
      const ch=get('SELECT * FROM channels WHERE id=?',c.channel_id);if(!ch.enabled)fail(400,'Kênh đang tạm dừng.');if(ch.mode==='live'&&!ch.verified)fail(400,ch.provider==='facebook_personal'?'Facebook cá nhân đang mất kết nối. Kiểm tra trạng thái kênh.':ch.provider==='zalo_personal'?'Zalo cá nhân chưa kết nối. Quản trị viên cần kiểm tra hoặc quét QR lại.':'Quản trị viên cần kiểm tra token đúng Page/OA trước khi gửi.');const text=clean(body.text,2001),rid=clean(body.request_id,80);if((!text&&!body.attachment_id)||text.length>2000||!rid)fail(400,'Nhập tin nhắn hoặc chọn tệp và mã yêu cầu.');if(body.attachment_id&&(text||c.kind==='comment'))fail(400,'Gửi tệp trong một tin nhắn riêng.');
      const old=get('SELECT * FROM messages WHERE conversation_id=? AND request_id=?',id,rid);if(old)return send(200,old);
      if(ch.provider==='facebook_personal'&&body.attachment_id)fail(400,'Facebook cá nhân hiện chỉ hỗ trợ gửi văn bản.');
      const attachment=body.attachment_id?features.attachment(c,body.attachment_id):null;
      const msg=run("INSERT INTO messages(conversation_id,request_id,kind,body,sender_id,created,status,attachment_id) VALUES(?,?,'outgoing',?,?,?,'sending',?)",id,rid,attachment?'[Tệp: '+attachment.name+']':text,u.id,now(),attachment?.id||null);const mid=Number(msg.lastInsertRowid);
      if(attachment)run('UPDATE attachments SET message_id=? WHERE id=?',mid,attachment.id);
      try{let ext=null;if(ch.mode==='live'){
       if(!ch.secret)throw new Error('Kênh chưa có token.');const s=decrypt(ch.secret);let data;
       if(ch.provider==='facebook_personal')data=await fbPersonal.send(c,text,attachment);
       else if(ch.provider==='zalo_personal')data=await personal.send(c,text,attachment);
       else if(attachment)data=await features.sendAttachment(ch,c,attachment);
       else if(ch.provider==='facebook'&&c.kind==='comment')data=await transport(`https://graph.facebook.com/${s.graph_version}/${encodeURIComponent(c.comment_id)}/comments`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+s.access_token},body:JSON.stringify({message:text})});
       else if(ch.provider==='facebook')data=await transport(`https://graph.facebook.com/${s.graph_version}/${ch.external_id}/messages`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+s.access_token},body:JSON.stringify({recipient:{id:c.external_id},messaging_type:'RESPONSE',message:{text}})});
       else data=await transport('https://openapi.zalo.me/v3.0/oa/message/cs',{method:'POST',headers:{'Content-Type':'application/json',access_token:s.access_token},body:JSON.stringify({recipient:{user_id:c.external_id},message:{text}})});
       ext=(c.kind==='comment'?data.id:data.message_id||data.data?.message_id)||null;if(!ext)throw new Error('API chưa xác nhận mã tin nhắn.');
      }
      tx(()=>{if(ext){const echo=get('SELECT id FROM messages WHERE conversation_id=? AND external_id=?',id,String(ext));if(echo&&echo.id!==mid)run('DELETE FROM messages WHERE id=?',echo.id);}run('UPDATE messages SET status=?,external_id=? WHERE id=?',ch.mode==='demo'?'demo':'sent',ext?String(ext):null,mid);run('UPDATE conversations SET updated=?,version=version+1 WHERE id=?',now(),id);audit(u,id,ch.mode==='demo'?'Trả lời thử nghiệm':c.kind==='comment'?'Trả lời bình luận':'Gửi tin nhắn');});
      }catch{run("UPDATE messages SET status='failed',error=? WHERE id=?",ch.provider==='zalo_personal'?'Chưa xác nhận gửi qua Zalo. Kiểm tra kết nối và tin gốc trong Zalo trước khi gửi lại.':'Không xác nhận được gửi. Kiểm tra token/quyền/hạn mức và hộp thư gốc trước khi gửi lại.',mid);audit(u,id,'Gửi tin thất bại');}
      return send(200,get('SELECT * FROM messages WHERE id=?',mid));
     }
     fail(405,'Thao tác không hỗ trợ.');
    }
    if(p==='/api/channels'&&req.method==='POST'){
     admin(u);const name=clean(body.name),provider=body.provider,external=clean(body.external_id),s={access_token:clean(body.access_token,4096),app_secret:clean(body.app_secret,500),app_id:clean(body.app_id),verify_token:clean(body.verify_token,200),graph_version:clean(body.graph_version||'v25.0')};
     if(!name||!['facebook','zalo'].includes(provider)||!/^\d+$/.test(external)||!s.access_token||!s.app_secret)fail(400,'Nhập tên, ID số, Access Token và App Secret.');
     if(provider==='zalo'&&!/^\d+$/.test(s.app_id))fail(400,'Zalo cần App ID số.');if(provider==='facebook'&&(!s.verify_token||!/^v\d+\.\d+$/.test(s.graph_version)))fail(400,'Facebook cần Verify Token và phiên bản Graph API.');
     if(get('SELECT id FROM channels WHERE provider=? AND external_id=?',provider,external))fail(409,'Kênh này đã tồn tại.');const r=run('INSERT INTO channels(name,provider,external_id,secret) VALUES(?,?,?,?)',name,provider,external,encrypt(s));audit(u,null,'Thêm kênh',name);return send(201,{id:Number(r.lastInsertRowid)});
    }
    m=p.match(/^\/api\/channels\/(\d+)(?:\/(check|credentials|history))?$/);
    if(m){admin(u);const c=get('SELECT * FROM channels WHERE id=?',Number(m[1]));if(!c)fail(404,'Không tìm thấy kênh.');
     if(m[2]==='history'&&req.method==='POST'){try{return send(200,await history.sync(c));}catch(e){fail(502,e.message);}}
     if(!m[2]&&req.method==='DELETE'){
      if(history.busy.has(c.id))fail(409,'Kênh đang đồng bộ lịch sử. Vui lòng chờ.');
      if(body.confirm!==true)fail(400,'Cần xác nhận xoá kênh và lịch sử trong Choibox.');
      const ids=all('SELECT m.id,m.status FROM messages m JOIN conversations co ON co.id=m.conversation_id WHERE co.channel_id=?',c.id);
      if(ids.some(m=>m.status==='sending'||moderationBusy.has(m.id)))fail(409,'Kênh đang gửi hoặc xử lý nội dung. Thử lại sau.');
      if(c.provider==='zalo_personal')personal.stop(c.id);if(c.provider==='facebook_personal')await fbPersonal.remove(c);
      if(shared)await shared.release(c);
      tx(()=>{run('DELETE FROM facebook_comments WHERE channel_id=?',c.id);run('DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE channel_id=?)',c.id);run('DELETE FROM audit WHERE conversation_id IN (SELECT id FROM conversations WHERE channel_id=?)',c.id);run('DELETE FROM conversations WHERE channel_id=?',c.id);run('DELETE FROM grants WHERE channel_id=?',c.id);run('DELETE FROM channels WHERE id=?',c.id);audit(u,null,'Xoá kênh khỏi Choibox',c.name);});return send(200,{ok:true});
     }
     if(m[2]==='credentials'&&req.method==='POST'){if(c.provider==='facebook_personal')fail(400,'Facebook cá nhân cần đăng nhập lại để kết nối.');if(c.provider==='zalo_personal')fail(400,'Zalo cá nhân cần kết nối lại bằng mã QR.');if(c.mode==='demo')fail(400,'Kênh thử nghiệm không có token.');const s=decrypt(c.secret);for(const k of ['access_token','app_secret','app_id','verify_token','graph_version'])if(body[k])s[k]=clean(body[k],4096);if(!/^v\d+\.\d+$/.test(s.graph_version)||c.provider==='zalo'&&!/^\d+$/.test(s.app_id))fail(400,'Cấu hình không hợp lệ.');run('UPDATE channels SET secret=?,health=?,verified=0 WHERE id=?',encrypt(s),'Cần kiểm tra lại',c.id);audit(u,null,'Cập nhật token',c.name);return send(200,{ok:true});}
     if(!m[2]&&req.method==='PATCH'){run('UPDATE channels SET enabled=? WHERE id=?',body.enabled?1:0,c.id);if(c.provider==='zalo_personal')personal.toggle(c,!!body.enabled);if(c.provider==='facebook_personal')fbPersonal.toggle(c,!!body.enabled);audit(u,null,body.enabled?'Bật kênh':'Tạm dừng kênh',c.name);return send(200,{ok:true});}
     if(m[2]==='check'&&req.method==='POST'){if(c.provider==='facebook_personal')return send(200,await fbPersonal.check(c));if(c.provider==='zalo_personal')return send(200,personal.check(c));return send(200,await checkAuthChannel(c));}
    }
    if(p==='/api/access'&&req.method==='GET'){admin(u);const port=req.socket.localPort;return send(200,{public_url:publicUrl,login_urls:publicUrl?[publicUrl]:networkConfig.localAddresses().map(ip=>`http://${ip}:${port}`),single_admin:true,connection_file:{app:'Choibox',serverUrl:publicUrl||('http://'+req.headers.host)}});}
    if(p==='/api/users'&&req.method==='GET'){admin(u);return send(200,all('SELECT id,name,email,role,active FROM users').map(x=>({...x,grants:all('SELECT channel_id,can_reply FROM grants WHERE user_id=?',x.id)})));}
    if(p==='/api/users'&&req.method==='POST'){
     admin(u);if(body.role==='admin')fail(400,'Không gian làm việc chỉ có một tài khoản quản trị.');validPassword(body.password);const name=clean(body.name),email=clean(body.email).toLowerCase();if(!name||!email.includes('@')||!['admin','manager','agent','viewer'].includes(body.role))fail(400,'Thông tin tài khoản không hợp lệ.');if(get('SELECT id FROM users WHERE email=?',email))fail(409,'Email đã tồn tại.');const r=run('INSERT INTO users(name,email,password,role) VALUES(?,?,?,?)',name,email,password(body.password),body.role);audit(u,null,'Tạo tài khoản',email);return send(201,{id:Number(r.lastInsertRowid)});
    }
    m=p.match(/^\/api\/users\/(\d+)$/);
    if(m&&req.method==='PATCH'){
     admin(u);const id=Number(m[1]),target=get('SELECT * FROM users WHERE id=?',id);if(!target)fail(404,'Không tìm thấy tài khoản.');const role=body.role??target.role,active=body.active===undefined?target.active:(body.active?1:0);if(role==='admin'&&target.role!=='admin')fail(400,'Không gian làm việc chỉ có một tài khoản quản trị.');if(!['admin','manager','agent','viewer'].includes(role))fail(400,'Vai trò không hợp lệ.');if(id===u.id&&(role!=='admin'||!active))fail(400,'Không thể tự bỏ quyền quản trị hoặc khóa chính mình.');
     if(body.password)validPassword(body.password);if(body.grants!==undefined&&(!Array.isArray(body.grants)||body.grants.some(g=>!get('SELECT id FROM channels WHERE id=?',g.channel_id))))fail(400,'Danh sách quyền không hợp lệ.');
     tx(()=>{run('UPDATE users SET role=?,active=?,password=? WHERE id=?',role,active,body.password?password(body.password):target.password,id);if(body.grants!==undefined){run('DELETE FROM grants WHERE user_id=?',id);for(const g of body.grants)run('INSERT INTO grants VALUES(?,?,?)',id,g.channel_id,g.can_reply?1:0);}if(id!==u.id)run('DELETE FROM sessions WHERE user_id=?',id);audit(u,null,'Cập nhật quyền tài khoản',target.email);});return send(200,{ok:true});
    }
    if(p==='/api/replies'&&req.method==='POST'){admin(u);if(!clean(body.title)||!clean(body.body))fail(400,'Nhập tên và nội dung mẫu.');run('INSERT INTO replies(title,body) VALUES(?,?)',clean(body.title),clean(body.body,2000));return send(201,{ok:true});}
    if(p==='/api/audit'&&req.method==='GET'){admin(u);return send(200,all('SELECT a.*,u.name user_name FROM audit a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 300'));}
    if(p==='/api/demo'&&req.method==='POST'){
     admin(u);if(get("SELECT id FROM channels WHERE mode='demo'"))fail(409,'Đã có dữ liệu thử nghiệm.');tx(()=>{for(const [name,provider,external] of [['Mộc Studio • Page mẫu','facebook','demo-fb'],['Mộc Care • OA mẫu','zalo','demo-zalo']])run("INSERT INTO channels(name,provider,external_id,mode,health) VALUES(?,?,?,'demo','Dữ liệu thử nghiệm')",name,provider,external);for(const [title,text] of [['Chào khách','Chào bạn, mình có thể hỗ trợ gì cho bạn ạ?'],['Xin thông tin','Bạn cho mình xin số điện thoại và nhu cầu để tư vấn nhé.']])run('INSERT INTO replies(title,body) VALUES(?,?)',title,text);});
     const ch=all("SELECT * FROM channels WHERE mode='demo'");for(const [i,name,text] of [[0,'Nguyễn Minh Anh','Mình muốn hỏi thêm về sản phẩm này ạ.'],[1,'Trần Hoàng Nam','Shop kiểm tra giúp mình đơn hàng hôm qua nhé.'],[0,'Lê Thảo','Sản phẩm màu be còn hàng không bạn?'],[1,'Phạm Khánh Linh','Mình cần tư vấn gói dịch vụ cho cửa hàng.']])ingest(ch[i],'demo-'+name,name,'demo-'+name,text);audit(u,null,'Tạo dữ liệu thử nghiệm');return send(201,{ok:true});
    }
    fail(404,'API không tồn tại.');
   }
   if(req.method!=='GET')fail(405,'Method không hỗ trợ.');const files={'/':'index.html','/app.js':'app.js','/message-layout.js':'message-layout.js','/workspace-ui.js':'workspace-ui.js','/zalo-personal-ui.js':'zalo-personal-ui.js','/facebook-personal-ui.js':'facebook-personal-ui.js','/style.css':'style.css','/logo.png':'logo.png'};const f=files[p];if(!f)fail(404,'Không tìm thấy.');
   const type=f.endsWith('.png')?'image/png':f.endsWith('.js')?'text/javascript; charset=utf-8':f.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8';
   send(200,fs.readFileSync(path.join(ROOT,'public',f)),type,{'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; media-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"});
  }catch(e){send(e.status||500,{error:e.status?e.message:'Có lỗi xử lý. Vui lòng thử lại.'});}
 });
 server.requestTimeout=120000;server.headersTimeout=10000;
 server.on('close',()=>{appClosing=true;clearInterval(channelHeartbeat);features.close();personal.close();fbPersonal.close();shared?.close();});
 return {server,db,ingest,shared,personal,fbPersonal,setPublicUrl(url){publicUrl=url?networkConfig.normalizeServerUrl(url):'';},close(){appClosing=true;clearInterval(channelHeartbeat);features.close();personal.close();fbPersonal.close();shared?.close();server.close();db.close();}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const app=createApp(),port=Number(process.env.PORT||4317),host=process.env.HOST||'127.0.0.1';
 app.db.prepare("UPDATE messages SET status='failed',error=? WHERE status='sending'").run('Ứng dụng dừng khi đang gửi; kiểm tra hộp thư gốc trước khi gửi lại.');
 app.server.listen(port,host,()=>console.log(`Choibox đang chạy: http://${host}:${port}`));
 const shutdown=()=>{app.server.close(()=>{app.db.close();process.exit(0);});};process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
}
