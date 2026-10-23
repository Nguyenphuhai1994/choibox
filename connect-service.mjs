// Shared Meta connection service. Run on a server, never bundle its data or App Secret.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,createHash,createHmac,createCipheriv,createDecipheriv,timingSafeEqual} from 'node:crypto';
const hash=v=>createHash('sha256').update(v).digest('hex');
const nonce=()=>randomBytes(24).toString('hex');
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const scopes='pages_show_list,pages_messaging,pages_manage_metadata,pages_read_engagement,pages_read_user_content,pages_manage_engagement';
export async function connectFetch(url,options={}) {
 const r=await fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(20000)});
 const d=await r.json();if(!r.ok||d.error)fail(502,'Dịch vụ kết nối hoặc Meta từ chối yêu cầu.');return d;
}
export function createConnectService({dataDir,publicUrl,appId,appSecret,verifyToken,configId='',graphVersion='v25.0',transport=connectFetch,clock=Date.now,retentionDays=7}) {
 const base=new URL(publicUrl);
 if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash||base.pathname!=='/')throw Error('publicUrl must be an HTTPS origin');
 if(!/^\d+$/.test(appId)||!appSecret||!verifyToken||!/^v\d+\.\d+$/.test(graphVersion)||!Number.isInteger(retentionDays)||retentionDays<1)throw Error('Invalid Meta service configuration');
 fs.mkdirSync(dataDir,{recursive:true,mode:0o700});
 const keyFile=path.join(dataDir,'secret.key');
 if(!fs.existsSync(keyFile))fs.writeFileSync(keyFile,randomBytes(32),{mode:0o600,flag:'wx'});
 const key=fs.readFileSync(keyFile);
 const encrypt=v=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv),b=Buffer.concat([c.update(JSON.stringify(v)),c.final()]);return JSON.stringify([iv.toString('hex'),c.getAuthTag().toString('hex'),b.toString('hex')]);};
 const decrypt=v=>{const [iv,tag,b]=JSON.parse(v),c=createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'hex'));c.setAuthTag(Buffer.from(tag,'hex'));return JSON.parse(Buffer.concat([c.update(Buffer.from(b,'hex')),c.final()]).toString());};
 const db=new DatabaseSync(path.join(dataDir,'connect.sqlite'));
 db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS tenants(id TEXT PRIMARY KEY,name TEXT NOT NULL,key_hash TEXT UNIQUE NOT NULL,active INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE IF NOT EXISTS pages(id TEXT PRIMARY KEY,tenant TEXT NOT NULL REFERENCES tenants(id),name TEXT NOT NULL,secret TEXT NOT NULL,ready INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,tenant TEXT NOT NULL REFERENCES tenants(id),page TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,fingerprint TEXT NOT NULL,payload TEXT NOT NULL,created INTEGER NOT NULL,UNIQUE(tenant,fingerprint));
 CREATE INDEX IF NOT EXISTS pending_events ON events(tenant,id);`);
 const get=(s,...p)=>db.prepare(s).get(...p),all=(s,...p)=>db.prepare(s).all(...p),run=(s,...p)=>db.prepare(s).run(...p);
 const flows=new Map(),locks=new Set();
 const redirect=base.origin+'/oauth/facebook/callback';
 const graph=(p,args={})=>'https://graph.facebook.com/'+graphVersion+'/'+p+'?'+new URLSearchParams(args);
 const proof=token=>createHmac('sha256',appSecret).update(token).digest('hex');
 function prune(){for(const [id,f] of flows)if(f.expires<=clock())flows.delete(id);run('DELETE FROM events WHERE created<?',clock()-retentionDays*86400000);}
 function tenant(req){const value=req.headers.authorization?.match(/^Bearer ([a-f0-9]{48})$/)?.[1];const t=value&&get('SELECT * FROM tenants WHERE key_hash=? AND active=1',hash(value));if(!t)fail(401,'Máy chủ Choibox chưa được kích hoạt hoặc đã bị thu hồi.');return t;}
 function flow(id,t){const f=flows.get(id);if(!f||f.tenant!==t.id||f.expires<=clock())fail(410,'Phiên kết nối hết hạn.');return f;}
 const active=f=>f.expires>clock()&&get('SELECT id FROM tenants WHERE id=? AND active=1',f.tenant)&&flows.get(f.id)===f;
 async function callback(url){
  const state=url.searchParams.get('state')||'',f=[...flows.values()].find(v=>v.state===hash(state));
  if(!f||!active(f)||f.status!=='waiting')fail(410,'Phiên đăng nhập đã hết hạn hoặc đã được sử dụng.');
  f.status='exchanging';
  try{
   const code=url.searchParams.get('code');if(url.searchParams.has('error')||!code||code.length>4096)throw Error();
   const short=await transport(graph('oauth/access_token',{client_id:appId,client_secret:appSecret,redirect_uri:redirect,code}));
   if(!short.access_token)throw Error();
   const long=await transport(graph('oauth/access_token',{client_id:appId,client_secret:appSecret,grant_type:'fb_exchange_token',fb_exchange_token:short.access_token}));
   if(!long.access_token)throw Error();
   const headers={Authorization:'Bearer '+long.access_token},args={appsecret_proof:proof(long.access_token)};
   const permissions=await transport(graph('me/permissions',args),{headers});
   const granted=new Set((permissions.data||[]).filter(v=>v.status==='granted').map(v=>v.permission));
   if(scopes.split(',').some(v=>!granted.has(v)))throw Error();
   const pages=new Map(),seen=new Set();let after='';
   for(let i=0;i<20;i++){
    const d=await transport(graph('me/accounts',{...args,fields:'id,name,access_token',limit:'100',...(after?{after}:{})}),{headers});
    for(const p of d.data||[])if(/^\d+$/.test(String(p.id))&&typeof p.access_token==='string')pages.set(String(p.id),{id:String(p.id),name:String(p.name||p.id),access_token:p.access_token});
    if(!d.paging?.next)break;after=d.paging.cursors?.after;if(!after||seen.has(after)||i===19)throw Error();seen.add(after);
   }
   if(!active(f))throw Error();f.pages=[...pages.values()];f.status='ready';
  }catch{f.status='failed';f.error='Chưa hoàn tất đăng nhập. Kiểm tra quyền của tài khoản, quyền Meta đã duyệt và thử lại.';}
  return 'Quay lại Choibox để xem kết quả và chọn Page. Bạn có thể đóng cửa sổ này.';
 }
 function enqueue(body,raw,signature){
  const expected='sha256='+createHmac('sha256',appSecret).update(raw).digest('hex');
  if(typeof signature!=='string'||signature.length!==expected.length||!timingSafeEqual(Buffer.from(expected),Buffer.from(signature)))fail(403,'Chữ ký không hợp lệ.');
  if(body.object!=='page'||!Array.isArray(body.entry))fail(400,'Webhook Page không hợp lệ.');
  db.exec('BEGIN IMMEDIATE');try{
   for(const entry of body.entry){
    const p=get('SELECT p.* FROM pages p JOIN tenants t ON t.id=p.tenant WHERE p.id=? AND t.active=1',String(entry.id));if(!p)continue;
    const fingerprint=hash(JSON.stringify(entry));if(get('SELECT id FROM events WHERE tenant=? AND fingerprint=?',p.tenant,fingerprint))continue;
    if(get('SELECT count(*) n FROM events WHERE tenant=?',p.tenant).n>=100000)fail(503,'Hàng đợi đã đầy.');
    run('INSERT INTO events(tenant,page,fingerprint,payload,created) VALUES(?,?,?,?,?)',p.tenant,p.id,fingerprint,encrypt(entry),clock());
   }db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
 }
 const server=http.createServer(async(req,res)=>{
  const send=(status,data,text=false)=>{res.writeHead(status,{'Content-Type':text?'text/plain; charset=utf-8':'application/json','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});res.end(text?data:JSON.stringify(data));};
  try{
   prune();const url=new URL(req.url,base),p=url.pathname;
   if(p==='/health'&&req.method==='GET')return send(200,{service:'Choibox Connect'});
   if(p==='/oauth/facebook/callback'&&req.method==='GET')return send(200,await callback(url),true);
   const webhook=p==='/webhooks/facebook';
   if(webhook&&req.method==='GET'){
    if(url.searchParams.get('hub.mode')!=='subscribe'||hash(url.searchParams.get('hub.verify_token')||'')!==hash(verifyToken))fail(403,'Verify Token không đúng.');
    return send(200,url.searchParams.get('hub.challenge')||'',true);
   }
   const t=webhook?null:tenant(req);let raw=Buffer.alloc(0);
   for await(const chunk of req){raw=Buffer.concat([raw,chunk]);if(raw.length>1024*1024)fail(413,'Dữ liệu quá lớn.');}
   let body={};try{if(raw.length)body=JSON.parse(raw);}catch{fail(400,'JSON không hợp lệ.');}
   if(webhook){if(req.method!=='POST')fail(405,'Method');enqueue(body,raw,req.headers['x-hub-signature-256']);return send(200,{ok:true});}
   if(p==='/v1/status'&&req.method==='GET')return send(200,{workspace:t.id,name:t.name,retention_days:retentionDays});
   if(p==='/v1/flows'&&req.method==='POST'){
    if([...flows.values()].filter(f=>f.tenant===t.id).length>=10||flows.size>=10000)fail(429,'Quá nhiều phiên đăng nhập. Chờ phiên cũ hết hạn.');
    const id=nonce(),state=nonce();flows.set(id,{id,tenant:t.id,state:hash(state),status:'waiting',expires:clock()+600000,pages:[]});
    return send(201,{id,url:'https://www.facebook.com/'+graphVersion+'/dialog/oauth?'+new URLSearchParams({client_id:appId,redirect_uri:redirect,state,response_type:'code',...(configId?{config_id:configId}:{scope:scopes,auth_type:'rerequest'})})});
   }
   const m=p.match(/^\/v1\/flows\/([a-f0-9]{48})(?:\/(connect))?$/);
   if(m){const f=flow(m[1],t);
    if(req.method==='GET'&&!m[2])return send(200,{status:f.status,error:f.error,pages:f.status==='ready'?f.pages.map(p=>({id:p.id,name:p.name})):[]});
    if(req.method==='DELETE'&&!m[2]){if(f.status==='connecting')fail(409,'Đang kết nối.');flows.delete(f.id);return send(200,{ok:true});}
    if(req.method==='POST'&&m[2]){
     const ids=body.page_ids;if(f.status!=='ready')fail(409,'Phiên chưa sẵn sàng.');
     if(!Array.isArray(ids)||!ids.length||ids.length>100||new Set(ids).size!==ids.length||ids.some(id=>!f.pages.some(p=>p.id===id)))fail(400,'Page không thuộc phiên đăng nhập này.');
     f.status='connecting';const results=[];
     try{for(const id of ids){
      if(!active(f))fail(410,'Phiên hết hạn.');const page=f.pages.find(p=>p.id===id),existing=get('SELECT tenant FROM pages WHERE id=?',id);
      if(locks.has(id)||existing&&existing.tenant!==t.id){results.push({id,name:page.name,ok:false,error:'Page đang được kết nối ở không gian khác. Liên hệ quản trị Choibox để chuyển.'});continue;}
      locks.add(id);
      try{
       const secret={access_token:page.access_token,appsecret_proof:proof(page.access_token),graph_version:graphVersion,shared:true};
       if(!existing)run('INSERT INTO pages(id,tenant,name,secret) VALUES(?,?,?,?)',id,t.id,page.name,encrypt(secret));
       const d=await transport(graph(id+'/subscribed_apps'),{method:'POST',headers:{Authorization:'Bearer '+page.access_token,'Content-Type':'application/json'},body:JSON.stringify({appsecret_proof:secret.appsecret_proof,subscribed_fields:'messages,messaging_postbacks,message_deliveries,message_reads,feed'})});
       if(d.success!==true||!active(f))throw Error();
       run('UPDATE pages SET name=?,secret=?,ready=1 WHERE id=? AND tenant=?',page.name,encrypt(secret),id,t.id);
       results.push({id,name:page.name,ok:true});
      }catch{if(!existing)run('DELETE FROM pages WHERE id=? AND tenant=?',id,t.id);results.push({id,name:page.name,ok:false,error:'Chưa đăng ký được nhận tin. Kiểm tra quyền Meta và thử lại.'});}finally{locks.delete(id);}
     }}finally{f.status='ready';}
     return send(200,{results});
    }
   }
   if(p==='/v1/pages'&&req.method==='GET')return send(200,{pages:all('SELECT * FROM pages WHERE tenant=? AND ready=1',t.id).map(p=>({id:p.id,name:p.name,secret:decrypt(p.secret)}))});
   const pm=p.match(/^\/v1\/pages\/(\d+)$/);
   if(pm&&req.method==='DELETE'){
    if(locks.has(pm[1]))fail(409,'Page đang kết nối.');
    run('DELETE FROM pages WHERE id=? AND tenant=?',pm[1],t.id);return send(200,{ok:true});
   }
   if(p==='/v1/events'&&req.method==='GET')return send(200,{events:all('SELECT * FROM events WHERE tenant=? ORDER BY id LIMIT 100',t.id).map(e=>({id:e.id,page:e.page,entry:decrypt(e.payload)}))});
   if(p==='/v1/events/ack'&&req.method==='POST'){
    if(!Array.isArray(body.ids)||body.ids.length>100||body.ids.some(id=>!Number.isSafeInteger(id)||id<1))fail(400,'Mã sự kiện không hợp lệ.');
    db.exec('BEGIN IMMEDIATE');try{for(const id of body.ids)run('DELETE FROM events WHERE id=? AND tenant=?',id,t.id);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
    return send(200,{ok:true});
   }
   fail(404,'Không tìm thấy thao tác.');
  }catch(e){send(e.status||500,{error:e.status?e.message:'Dịch vụ kết nối gặp lỗi.'});}
 });
 server.requestTimeout=30000;server.headersTimeout=15000;
 return {server,db,createTenant(name){const id=nonce(),token=nonce();run('INSERT INTO tenants(id,name,key_hash) VALUES(?,?,?)',id,String(name).slice(0,200),hash(token));return {id,token};},importPages(tenant,pages){
  if(!get('SELECT id FROM tenants WHERE id=? AND active=1',tenant))throw Error('Unknown tenant');
  db.exec('BEGIN IMMEDIATE');try{for(const p of pages){
   if(!/^\d+$/.test(p.id)||!p.access_token||get('SELECT id FROM pages WHERE id=?',p.id))throw Error('Invalid or already owned Page');
   run('INSERT INTO pages(id,tenant,name,secret,ready) VALUES(?,?,?,?,1)',p.id,tenant,p.name,encrypt({shared:true,access_token:p.access_token,appsecret_proof:proof(p.access_token),graph_version:graphVersion}));
  }db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
 },revokeTenant(id){run('UPDATE tenants SET active=0 WHERE id=?',id);for(const [key,f] of flows)if(f.tenant===id)flows.delete(key);},close(){server.close();db.close();}};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
 process.umask(0o077);
 const service=createConnectService({dataDir:process.env.CONNECT_DATA_DIR||'connect-data',publicUrl:process.env.CONNECT_PUBLIC_URL,appId:process.env.META_APP_ID,appSecret:process.env.META_APP_SECRET,verifyToken:process.env.META_VERIFY_TOKEN,configId:process.env.META_CONFIG_ID,graphVersion:process.env.META_GRAPH_VERSION||'v25.0'});
 if(process.argv[2]==='create-tenant'){
  const out=process.argv[4];if(!process.argv[3]||!out)throw Error('Usage: create-tenant NAME OUTPUT.json');
  // Credential is written to a private file, never console or process arguments.
  const fd=fs.openSync(out,'wx',0o600);try{const t=service.createTenant(process.argv[3]);fs.writeFileSync(fd,JSON.stringify({url:process.env.CONNECT_PUBLIC_URL,token:t.token,workspace:t.id},null,2));}finally{fs.closeSync(fd);service.close();}
 }else if(process.argv[2]==='revoke-tenant'){service.revokeTenant(process.argv[3]);service.close();}
 else service.server.listen(Number(process.env.PORT||4320),'127.0.0.1',()=>console.log('Choibox Connect listening on loopback'));
}
