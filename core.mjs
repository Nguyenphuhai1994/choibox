// Shared Meta broker for Cloudflare. Storage and transactions are injected.
import {randomBytes,createHash,createHmac,createCipheriv,createDecipheriv,timingSafeEqual} from 'node:crypto';
const hash=v=>createHash('sha256').update(v).digest('hex');
const nonce=()=>randomBytes(24).toString('hex');
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const scopes='pages_show_list,pages_messaging,pages_manage_metadata,pages_read_engagement,pages_read_user_content,pages_manage_engagement';
export async function connectFetch(url,options={}) {
 let r;
 // workerd does not consistently support redirect:error. Preserve the no-follow
 // policy explicitly so credentials can never be forwarded to a redirect target.
 try{r=await fetch(url,{...options,redirect:'manual',signal:AbortSignal.timeout(20000)});}
 catch(cause){throw Object.assign(new Error('Không gọi được dịch vụ Meta.'),{status:502,transportKind:cause?.name==='TimeoutError'||cause?.name==='AbortError'?'timeout':/redirect/i.test(cause?.message||'')?'redirect_blocked':cause?.name==='TypeError'?'network_type_error':'network_error'});}
 if(r.status>=300&&r.status<400)throw Object.assign(new Error('Meta redirect bị chặn.'),{status:502,httpStatus:r.status,transportKind:'redirect_blocked'});
 let d;try{d=await r.json();}catch{throw Object.assign(new Error('Phản hồi Meta không phải JSON.'),{status:502,httpStatus:r.status,transportKind:'non_json_response'});}
 if(!r.ok||d.error){
  const e=Object.assign(new Error('Dịch vụ kết nối hoặc Meta từ chối yêu cầu.'),{status:502,httpStatus:r.status});
  if(Number.isInteger(d.error?.code))e.metaCode=d.error.code;
  if(Number.isInteger(d.error?.error_subcode))e.metaSubcode=d.error.error_subcode;
  throw e;
 }return d;
}
export function createBroker({db,transaction,encryptionKey,adminToken,publicUrl,appId,appSecret,verifyToken,configId='',graphVersion='v25.0',transport=connectFetch,clock=Date.now,retentionDays=7}) {
 const base=new URL(publicUrl);
 if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash||base.pathname!=='/')throw Error('publicUrl must be an HTTPS origin');
 if(!/^\d+$/.test(appId)||!appSecret||!verifyToken||!/^v\d+\.\d+$/.test(graphVersion)||!Number.isInteger(retentionDays)||retentionDays<1)throw Error('Invalid Meta service configuration');
 if(!/^[a-f0-9]{64}$/.test(encryptionKey)||!adminToken||adminToken.length<48)throw Error('Missing Worker secrets');
 const key=Buffer.from(encryptionKey,'hex');
 const encrypt=v=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv),b=Buffer.concat([c.update(JSON.stringify(v),'utf8'),c.final()]);return JSON.stringify([iv.toString('hex'),c.getAuthTag().toString('hex'),b.toString('hex')]);};
 const decrypt=v=>{const [iv,tag,b]=JSON.parse(v),c=createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'hex'));c.setAuthTag(Buffer.from(tag,'hex'));return JSON.parse(Buffer.concat([c.update(Buffer.from(b,'hex')),c.final()]).toString());};
 db.exec(` CREATE TABLE IF NOT EXISTS tenants(id TEXT PRIMARY KEY,name TEXT NOT NULL,key_hash TEXT UNIQUE NOT NULL,active INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE IF NOT EXISTS pages(id TEXT PRIMARY KEY,tenant TEXT NOT NULL REFERENCES tenants(id),name TEXT NOT NULL,secret TEXT NOT NULL,ready INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,tenant TEXT NOT NULL REFERENCES tenants(id),page TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,fingerprint TEXT NOT NULL,payload TEXT NOT NULL,created INTEGER NOT NULL,UNIQUE(tenant,fingerprint));
 CREATE INDEX IF NOT EXISTS pending_events ON events(tenant,id);
 CREATE INDEX IF NOT EXISTS events_expiry ON events(created);
 CREATE TABLE IF NOT EXISTS flows(id TEXT PRIMARY KEY,tenant TEXT NOT NULL,state TEXT UNIQUE NOT NULL,expires INTEGER NOT NULL,payload TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS flows_expiry ON flows(expires);
 CREATE TABLE IF NOT EXISTS leases(id TEXT PRIMARY KEY,expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS imports(id TEXT PRIMARY KEY,digest TEXT NOT NULL,result TEXT NOT NULL);`);
 const get=(s,...p)=>db.prepare(s).get(...p),all=(s,...p)=>db.prepare(s).all(...p),run=(s,...p)=>db.prepare(s).run(...p);
 // Persist encrypted OAuth state across Worker eviction.
 const wrap=f=>new Proxy(f,{set(target,prop,value){target[prop]=value;run('UPDATE flows SET payload=? WHERE id=?',encrypt(target),target.id);return true;}});
 const flows={
  get(id){const row=get('SELECT payload FROM flows WHERE id=?',id);return row?wrap(decrypt(row.payload)):undefined;},
  set(id,f){run('INSERT INTO flows(id,tenant,state,expires,payload) VALUES(?,?,?,?,?)',id,f.tenant,f.state,f.expires,encrypt(f));},
  delete(id){run('DELETE FROM flows WHERE id=?',id);},
  get size(){return get('SELECT count(*) n FROM flows').n;}
 };
 const locks={has(id){return !!get('SELECT id FROM leases WHERE id=? AND expires>?',id,clock());},add(id){run('INSERT OR REPLACE INTO leases(id,expires) VALUES(?,?)',id,clock()+600000);},delete(id){run('DELETE FROM leases WHERE id=?',id);}};
 const redirect=base.origin+'/oauth/facebook/callback';
 const graph=(p,args={})=>'https://graph.facebook.com/'+graphVersion+'/'+p+'?'+new URLSearchParams(args);
 const proof=token=>createHmac('sha256',appSecret).update(token).digest('hex');
 function prune(){transaction(()=>{
  run('DELETE FROM flows WHERE expires<=?',clock());
  run('DELETE FROM leases WHERE expires<=?',clock());
  run('DELETE FROM pages WHERE ready=0 AND id NOT IN (SELECT id FROM leases)');
  run('DELETE FROM events WHERE created<?',clock()-retentionDays*86400000);
 });}
 function tenant(req){const value=req.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{48})$/)?.[1];const t=value&&get('SELECT * FROM tenants WHERE key_hash=? AND active=1',hash(value));if(!t)fail(401,'Máy chủ Choibox chưa được kích hoạt hoặc đã bị thu hồi.');return t;}
 function flow(id,t){const f=flows.get(id);if(!f||f.tenant!==t.id||f.expires<=clock())fail(410,'Phiên kết nối hết hạn.');return f;}
 const active=f=>f.expires>clock()&&get('SELECT id FROM tenants WHERE id=? AND active=1',f.tenant)&&!!flows.get(f.id);
 async function callback(url){
  const state=url.searchParams.get('state')||'',row=get('SELECT id FROM flows WHERE state=?',hash(state)),f=row&&flows.get(row.id);
  if(!f||!active(f)||f.status!=='waiting')fail(410,'Phiên đăng nhập đã hết hạn hoặc đã được sử dụng.');
  f.status='exchanging';let stage='authorization';
  try{
   const code=url.searchParams.get('code');if(url.searchParams.has('error')||!code||code.length>4096)throw Error();
   stage='short_token';
   const short=await transport(graph('oauth/access_token',{client_id:appId,client_secret:appSecret,redirect_uri:redirect,code}));
   if(!short.access_token)throw Object.assign(new Error('Missing token'),{transportKind:'missing_access_token'});
   stage='long_token';
   const long=await transport(graph('oauth/access_token',{client_id:appId,client_secret:appSecret,grant_type:'fb_exchange_token',fb_exchange_token:short.access_token}));
   if(!long.access_token)throw Error();
   const headers={Authorization:'Bearer '+long.access_token},args={appsecret_proof:proof(long.access_token)};
   stage='permissions';
   const permissions=await transport(graph('me/permissions',args),{headers});
   const granted=new Set((permissions.data||[]).filter(v=>v.status==='granted').map(v=>v.permission));
   const missing=scopes.split(',').filter(v=>!granted.has(v));
   if(missing.length)throw Object.assign(new Error('Missing permissions'),{missingPermissions:missing});
   stage='pages';
   const pages=new Map(),seen=new Set();let after='';
   for(let i=0;i<20;i++){
    const d=await transport(graph('me/accounts',{...args,fields:'id,name,access_token',limit:'100',...(after?{after}:{})}),{headers});
    for(const p of d.data||[])if(/^\d+$/.test(String(p.id))&&typeof p.access_token==='string')pages.set(String(p.id),{id:String(p.id),name:String(p.name||p.id),access_token:p.access_token});
    if(!d.paging?.next)break;after=d.paging.cursors?.after;if(!after||seen.has(after)||i===19)throw Error();seen.add(after);
   }
   if(!active(f))throw Error();f.pages=[...pages.values()];f.status='ready';
  }catch(e){
   // Persist only an allowlist of diagnostic values, never Graph messages or URLs.
   const diagnostic={stage};
   if(['Error','TypeError','ReferenceError','RangeError','SyntaxError','DOMException'].includes(e.name))diagnostic.error_kind=e.name;
   const frame=String(e.stack||'').match(/worker\.js:(\d+):(\d+)/);if(frame)diagnostic.frame=[Number(frame[1]),Number(frame[2])];
   if(Number.isInteger(e.httpStatus))diagnostic.http_status=e.httpStatus;
   if(Number.isInteger(e.metaCode))diagnostic.meta_code=e.metaCode;
   if(Number.isInteger(e.metaSubcode))diagnostic.meta_subcode=e.metaSubcode;
   if(['timeout','redirect_blocked','network_type_error','network_error','non_json_response','missing_access_token'].includes(e.transportKind))diagnostic.transport=e.transportKind;
   if(Array.isArray(e.missingPermissions))diagnostic.missing_permissions=scopes.split(',').filter(p=>e.missingPermissions.includes(p));
   f.diagnostic=diagnostic;f.status='failed';f.error='Chưa hoàn tất đăng nhập. Kiểm tra quyền của tài khoản, quyền Meta đã duyệt và thử lại.';
  }
  return 'Quay lại Choibox để xem kết quả và chọn Page. Bạn có thể đóng cửa sổ này.';
 }
 function enqueue(body,raw,signature){
  const expected='sha256='+createHmac('sha256',appSecret).update(raw).digest('hex');
  if(typeof signature!=='string'||!/^sha256=[a-f0-9]{64}$/.test(signature)||!timingSafeEqual(Buffer.from(expected),Buffer.from(signature)))fail(403,'Chữ ký không hợp lệ.');
  if(body.object!=='page'||!Array.isArray(body.entry))fail(400,'Webhook Page không hợp lệ.');
  transaction(()=>{
   for(const entry of body.entry){
    const p=get('SELECT p.* FROM pages p JOIN tenants t ON t.id=p.tenant WHERE p.id=? AND t.active=1',String(entry.id));if(!p)continue;
    const fingerprint=hash(JSON.stringify(entry));if(get('SELECT id FROM events WHERE tenant=? AND fingerprint=?',p.tenant,fingerprint))continue;
    if(get('SELECT count(*) n FROM events WHERE tenant=?',p.tenant).n>=100000)fail(503,'Hàng đợi đã đầy.');
    // Start fresh IDs above legacy IDs; stale desktop acknowledgments cannot delete new events.
    const seq=get("SELECT seq FROM sqlite_sequence WHERE name='events'")?.seq||0;
    const id=Math.max(clock()*1000,seq+1);
    if(!Number.isSafeInteger(id))fail(503,'Mã sự kiện vượt giới hạn.');
    run('INSERT INTO events(id,tenant,page,fingerprint,payload,created) VALUES(?,?,?,?,?,?)',id,p.tenant,p.id,fingerprint,encrypt(entry),clock());
   }
  });
 }
 async function handle(req){
  const send=(status,data,text=false)=>new Response(text?data:JSON.stringify(data),{status,headers:{'Content-Type':text?'text/plain; charset=utf-8':'application/json','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'}});
  try{
   prune();const url=new URL(req.url,base),p=url.pathname;
   if(p==='/health'&&req.method==='GET')return send(200,{service:'Choibox Connect',public_url:base.origin,build:'2026-10-22-oauth-redirect-fix'});
   if(p==='/oauth/facebook/callback'&&req.method==='GET')return send(200,await callback(url),true);
   const webhook=p==='/webhooks/facebook';
   if(webhook&&req.method==='GET'){
    if(url.searchParams.get('hub.mode')!=='subscribe'||hash(url.searchParams.get('hub.verify_token')||'')!==hash(verifyToken))fail(403,'Verify Token không đúng.');
    return send(200,url.searchParams.get('hub.challenge')||'',true);
   }
   const admin=p.startsWith('/admin/');
   if(admin&&hash(req.headers.get('authorization')||'')!==hash('Bearer '+adminToken))fail(401,'Unauthorized');
   const t=webhook||admin?null:tenant(req);let raw=Buffer.alloc(0);
   for await(const chunk of req.body||[]){raw=Buffer.concat([raw,chunk]);if(raw.length>1024*1024)fail(413,'Dữ liệu quá lớn.');}
   let body={};try{if(raw.length)body=JSON.parse(raw);}catch{fail(400,'JSON không hợp lệ.');}
   if(webhook){if(req.method!=='POST')fail(405,'Method');enqueue(body,raw,req.headers.get('x-hub-signature-256'));return send(200,{ok:true});}
   if(p==='/admin/tenants'&&req.method==='POST'){
    if(typeof body.name!=='string'||!body.name.trim()||body.name.length>200)fail(400,'Tên không hợp lệ.');
    const created=createTenant(body.name.trim());return send(201,{url:base.origin,workspace:created.id,token:created.token});
   }
   if(p==='/admin/import'&&req.method==='POST')return send(200,importSnapshot(body));
   if(p==='/v1/status'&&req.method==='GET')return send(200,{workspace:t.id,name:t.name,retention_days:retentionDays});
   if(p==='/v1/flows'&&req.method==='POST'){
    if(get('SELECT count(*) n FROM flows WHERE tenant=?',t.id).n>=10||flows.size>=10000)fail(429,'Quá nhiều phiên đăng nhập. Chờ phiên cũ hết hạn.');
    const id=nonce(),state=nonce();flows.set(id,{id,tenant:t.id,state:hash(state),status:'waiting',expires:clock()+600000,pages:[]});
    return send(201,{id,url:'https://www.facebook.com/'+graphVersion+'/dialog/oauth?'+new URLSearchParams({client_id:appId,redirect_uri:redirect,state,response_type:'code',...(configId?{config_id:configId}:{scope:scopes,auth_type:'rerequest'})})});
   }
   const m=p.match(/^\/v1\/flows\/([a-f0-9]{48})(?:\/(connect))?$/);
   if(m){const f=flow(m[1],t);
    if(req.method==='GET'&&!m[2])return send(200,{status:f.status,error:f.error,diagnostic:f.diagnostic,pages:f.status==='ready'?f.pages.map(p=>({id:p.id,name:p.name})):[]});
    if(req.method==='DELETE'&&!m[2]){if(f.status==='connecting')fail(409,'Đang kết nối.');flows.delete(f.id);return send(200,{ok:true});}
    if(req.method==='POST'&&m[2]){
     const ids=body.page_ids;if(f.status!=='ready')fail(409,'Phiên chưa sẵn sàng.');
     if(!Array.isArray(ids)||!ids.length||ids.length>20||new Set(ids).size!==ids.length||ids.some(id=>!f.pages.some(p=>p.id===id)))fail(400,'Page không thuộc phiên đăng nhập này.');
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
    transaction(()=>{for(const id of body.ids)run('DELETE FROM events WHERE id=? AND tenant=?',id,t.id);});
    return send(200,{ok:true});
   }
   fail(404,'Không tìm thấy thao tác.');
  }catch(e){return send(e.status||500,{error:e.status?e.message:'Dịch vụ kết nối gặp lỗi.'});}
 }
 function createTenant(name){const id=nonce(),token=nonce();run('INSERT INTO tenants(id,name,key_hash) VALUES(?,?,?)',id,String(name).slice(0,200),hash(token));return {id,token};}
 function importSnapshot(snapshot){
  if(!snapshot||!/^[-a-zA-Z0-9]{8,80}$/.test(snapshot.id||'')||!Array.isArray(snapshot.tenants)||!Array.isArray(snapshot.pages)||!Array.isArray(snapshot.events)||snapshot.tenants.length>1000||snapshot.pages.length>1000||snapshot.events.length>1000)fail(400,'Bản chuyển dữ liệu không hợp lệ.');
  const digest=hash(JSON.stringify(snapshot)),done=get('SELECT * FROM imports WHERE id=?',snapshot.id);
  if(done){if(done.digest!==digest)fail(409,'Bản chuyển dữ liệu đã thay đổi.');return JSON.parse(done.result);}
  if(get('SELECT count(*) n FROM tenants').n||get('SELECT count(*) n FROM pages').n||get('SELECT count(*) n FROM events').n)fail(409,'Chỉ nhập vào dịch vụ chưa có dữ liệu khách hàng.');
  const tenants=new Map(),pages=new Map();
  try{
   for(const t of snapshot.tenants){
    if(!/^[a-f0-9]{48}$/.test(t.id)||!/^[a-f0-9]{64}$/.test(t.key_hash)||typeof t.name!=='string'||t.name.length>200||![0,1].includes(t.active)||tenants.has(t.id))throw Error();
    tenants.set(t.id,t);
   }
   for(const p of snapshot.pages){
    if(!/^\d+$/.test(p.id)||!tenants.has(p.tenant)||typeof p.name!=='string'||p.name.length>1000||p.ready!==1||pages.has(p.id))throw Error();
    const secret=decrypt(p.secret);
    if(secret.shared!==true||typeof secret.access_token!=='string'||secret.appsecret_proof!==proof(secret.access_token)||secret.graph_version!==graphVersion)throw Error();
    pages.set(p.id,p);
   }
   for(const e of snapshot.events){
    if(!Number.isSafeInteger(e.id)||e.id<1||!Number.isSafeInteger(e.created)||e.created<0||!pages.has(e.page)||pages.get(e.page).tenant!==e.tenant)throw Error();
    const entry=decrypt(e.payload);
    if(String(entry.id)!==e.page||hash(JSON.stringify(entry))!==e.fingerprint)throw Error();
   }
  }catch{fail(400,'Bản chuyển dữ liệu hoặc khóa mã hóa không khớp.');}
  const result={ok:true,tenants:snapshot.tenants.length,pages:snapshot.pages.length,events:snapshot.events.length};
  transaction(()=>{
   for(const t of snapshot.tenants)run('INSERT INTO tenants(id,name,key_hash,active) VALUES(?,?,?,?)',t.id,t.name,t.key_hash,t.active);
   for(const p of snapshot.pages)run('INSERT INTO pages(id,tenant,name,secret,ready) VALUES(?,?,?,?,1)',p.id,p.tenant,p.name,p.secret);
   for(const e of snapshot.events)run('INSERT INTO events(id,tenant,page,fingerprint,payload,created) VALUES(?,?,?,?,?,?)',e.id,e.tenant,e.page,e.fingerprint,e.payload,e.created);
   run('INSERT INTO imports(id,digest,result) VALUES(?,?,?)',snapshot.id,digest,JSON.stringify(result));
  });
  return result;
 }
 function importPages(tenant,pages){
  if(!get('SELECT id FROM tenants WHERE id=? AND active=1',tenant))throw Error('Unknown tenant');
  transaction(()=>{for(const p of pages){
   if(!/^\d+$/.test(p.id)||!p.access_token||get('SELECT id FROM pages WHERE id=?',p.id))throw Error('Invalid or already owned Page');
   run('INSERT INTO pages(id,tenant,name,secret,ready) VALUES(?,?,?,?,1)',p.id,tenant,p.name,encrypt({shared:true,access_token:p.access_token,appsecret_proof:proof(p.access_token),graph_version:graphVersion}));
  }});
 }
 function revokeTenant(id){run('UPDATE tenants SET active=0 WHERE id=?',id);run('DELETE FROM flows WHERE tenant=?',id);}
 return {handle,prune,createTenant,importPages,revokeTenant};
}
