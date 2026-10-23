import fs from 'node:fs';
import path from 'node:path';
import {connectFetch} from './connect-service.mjs';
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
// Only the local server reads this customer-specific credential; never the browser.
export function sharedFacebook({dataDir,db,encrypt,decrypt,ingestEntry,fetcher=connectFetch,pollMs=5000}) {
 const file=path.join(dataDir,'connect.json');if(!fs.existsSync(file))return null;
 const config=JSON.parse(fs.readFileSync(file,'utf8')),origin=new URL(config.url);
 if(origin.protocol!=='https:'||origin.pathname!=='/'||origin.search||origin.hash||origin.username||origin.password||!/^[a-f0-9]{48}$/.test(config.token))throw Error('Invalid Choibox Connect activation');
 const flows=new Map();let stopped=false,busy=false,lastSuccess=null,lastError=null;
 const call=(p,method='GET',body)=>fetcher(origin.origin+'/v1'+p,{method,headers:{Authorization:'Bearer '+config.token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const valid=(f,session,u)=>f&&f.session===session.token&&f.user===u.id&&f.expires>Date.now()&&db.prepare('SELECT token FROM sessions WHERE token=? AND expires>?').get(session.token,Date.now())&&db.prepare("SELECT id FROM users WHERE id=? AND active=1 AND role='admin'").get(u.id);
 async function syncPages(){
  const d=await call('/pages');if(stopped)return;
  for(const p of d.pages){
   if(!/^\d+$/.test(p.id)||!p.secret?.shared||!p.secret.access_token||!/^[a-f0-9]{64}$/.test(p.secret.appsecret_proof)||!/^v\d+\.\d+$/.test(p.secret.graph_version))throw Error('Invalid channel credentials');
   const old=db.prepare("SELECT secret FROM channels WHERE provider='facebook' AND external_id=?").get(p.id);
   if(old?.secret){const previous=decrypt(old.secret);if(previous.shared&&previous.access_token===p.secret.access_token&&previous.appsecret_proof===p.secret.appsecret_proof&&previous.graph_version===p.secret.graph_version)continue;}
   const secret=encrypt({...p.secret,connect_origin:origin.origin});
   db.prepare("INSERT INTO channels(name,provider,external_id,secret,verified,health) VALUES(?,'facebook',?,?,1,'Đã kết nối qua Choibox') ON CONFLICT(provider,external_id) DO UPDATE SET secret=excluded.secret,verified=1").run(p.name,p.id,secret);
  }
 }
 async function poll(){
  if(stopped||busy)return;busy=true;
  try{
   await syncPages();if(stopped)return;
   const d=await call('/events');if(stopped)return;const ids=[];
   for(const e of d.events){
    const c=db.prepare("SELECT * FROM channels WHERE provider='facebook' AND external_id=?").get(e.page);
    if(!c||!decrypt(c.secret)?.shared)continue;
    // A paused channel discards events, matching the direct webhook behaviour.
    if(!c.enabled){ids.push(e.id);continue;}
    if(String(e.entry.id)!==c.external_id)throw Error('Invalid routed event');
    ingestEntry(c,e.entry);ids.push(e.id);
   }
   if(ids.length)await call('/events/ack','POST',{ids});
   lastSuccess=new Date().toISOString();lastError=null;
  }catch{lastError='Chưa liên lạc được dịch vụ Choibox. Sẽ tự thử lại.';}finally{busy=false;}
 }
 const timer=setInterval(poll,pollMs);timer.unref();
 async function api({p,req,body,u,session,send,audit}){
  if(!p.startsWith('/api/facebook/'))return false;if(u.role!=='admin')fail(403,'Chỉ quản trị viên được kết nối Page.');
  for(const [id,f] of flows)if(f.expires<Date.now())flows.delete(id);
  if(p==='/api/facebook/config'&&req.method==='GET'){send(200,{configured:true,ready:true,shared:true,last_success:lastSuccess,error:lastError});return true;}
  if(p==='/api/facebook/config')fail(409,'Máy này sử dụng ứng dụng Meta chung của Choibox.');
  if(p==='/api/facebook/start'&&req.method==='POST'){
   const f=await call('/flows','POST',{});flows.set(f.id,{session:session.token,user:u.id,expires:Date.now()+600000});send(200,f);return true;
  }
  const m=p.match(/^\/api\/facebook\/flows\/([a-f0-9]{48})(?:\/(connect))?$/);
  if(m){const f=flows.get(m[1]);if(!valid(f,session,u))fail(410,'Phiên kết nối hết hạn.');
   if(req.method==='GET'&&!m[2]){const d=await call('/flows/'+m[1]);send(200,{...d,pages:(d.pages||[]).map(p=>({...p,connected:!!db.prepare("SELECT id FROM channels WHERE provider='facebook' AND external_id=?").get(p.id)}))});return true;}
   if(req.method==='DELETE'&&!m[2]){await call('/flows/'+m[1],'DELETE');flows.delete(m[1]);send(200,{ok:true});return true;}
   if(req.method==='POST'&&m[2]){
    const d=await call('/flows/'+m[1]+'/connect','POST',{page_ids:body.page_ids});await syncPages();audit(u,null,'Kết nối Page qua ứng dụng Meta chung');send(200,d);return true;
   }
  }
  fail(404,'Thao tác Facebook không tồn tại.');
 }
 return {api,poll,async release(c){if(c.provider==='facebook'&&c.secret&&decrypt(c.secret)?.shared){if(busy)fail(409,'Đang nhận dữ liệu, vui lòng thử lại sau vài giây.');busy=true;try{await call('/pages/'+c.external_id,'DELETE');}finally{busy=false;}}},close(){stopped=true;clearInterval(timer);}};
}
