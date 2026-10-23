import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHmac} from 'node:crypto';
import {createConnectService} from './connect-service.mjs';
import {createApp} from './server.mjs';
import activationParser from './desktop/activation.cjs';
const permissions='pages_show_list,pages_messaging,pages_manage_metadata,pages_read_engagement,pages_read_user_content,pages_manage_engagement'.split(',');
test('Activation accepts only the Choibox origin and never includes private input in errors',()=>{
 const valid={url:'https://connect.choiagency.top',token:'a'.repeat(48),workspace:'b'.repeat(48)};
 assert.deepEqual(activationParser.parseActivation(JSON.stringify(valid)),valid);
 for(const input of ['{"secret":"PRIVATE',JSON.stringify({...valid,url:'https://attacker.example'}),JSON.stringify({...valid,workspace:''})])assert.throws(()=>activationParser.parseActivation(input),e=>!e.message.includes('PRIVATE')&&!e.message.includes(valid.token));
});
async function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'choibox-connect-'));let now=Date.now(),broken=false;
 const options={dataDir:dir,publicUrl:'https://connect.example.test',appId:'123',appSecret:'APP-SECRET',verifyToken:'VERIFY',clock:()=>now,transport:async(raw,options={})=>{
  const u=new URL(raw);assert.equal(u.hostname,'graph.facebook.com');
  if(u.pathname.endsWith('/oauth/access_token'))return {access_token:'USER-TOKEN'};
  if(u.pathname.endsWith('/me/permissions'))return {data:permissions.map(permission=>({permission,status:'granted'}))};
  if(u.pathname.endsWith('/me/accounts'))return {data:[{id:'111',name:'Page A',access_token:'PAGE-A'},{id:'222',name:'Page B',access_token:'PAGE-B'}]};
  if(u.pathname.endsWith('/subscribed_apps')){if(broken)throw Error('SECRET-ERROR');assert.ok(JSON.parse(options.body).appsecret_proof);return {success:true};}
  throw Error('Unexpected Graph request');
 }};
 let app=createConnectService(options),base='';
 async function listen(){await new Promise(r=>app.server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+app.server.address().port;}
 await listen();
 t.after(async()=>{await new Promise(r=>app.server.close(r));app.db.close();rmSync(dir,{recursive:true,force:true});});
 async function request(p,token,method='GET',body,headers={}){
  const r=await fetch(base+p,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const text=await r.text();let data;try{data=JSON.parse(text);}catch{data=text;}return {status:r.status,data};
 }
 async function login(token){const f=(await request('/v1/flows',token,'POST',{})).data;const state=new URL(f.url).searchParams.get('state');assert.equal((await request('/oauth/facebook/callback?code=test&state='+state)).status,200);return {...f,state};}
 async function event(page,mid='m1',signature=true){const body={object:'page',entry:[{id:page,messaging:[{sender:{id:'900'},recipient:{id:page},timestamp:now,message:{mid,text:'PRIVATE MESSAGE'}}]}]};return request('/webhooks/facebook',null,'POST',body,{'x-hub-signature-256':signature?'sha256='+createHmac('sha256','APP-SECRET').update(JSON.stringify(body)).digest('hex'):'bad'});}
 return {get app(){return app;},request,login,event,tenant:name=>app.createTenant(name),breakMeta:v=>broken=v,advance:n=>now+=n,async restart(){await new Promise(r=>app.server.close(r));app.db.close();app=createConnectService(options);await listen();},async transport(url,options){const u=new URL(url);assert.equal(u.origin,'https://connect.example.test');const r=await request(u.pathname,options.headers.Authorization.slice(7),options.method,options.body?JSON.parse(options.body):undefined);if(r.status>=400)throw Error('Gateway denied');return r.data;}};
}
test('Shared Meta isolates tenants, forbids Page takeover, protects credentials and verifies webhooks',async t=>{
 const f=await fixture(t),a=f.tenant('A'),b=f.tenant('B');
 assert.equal((await f.request('/v1/pages')).status,401);
 const login=await f.login(a.token);
 assert.equal((await f.request('/oauth/facebook/callback?code=test&state='+login.state)).status,410);
 assert.equal((await f.request('/v1/flows/'+login.id,b.token)).status,410);
 assert.equal((await f.request('/v1/flows/'+login.id+'/connect',a.token,'POST',{page_ids:['333']})).status,400);
 assert.equal((await f.request('/v1/flows/'+login.id+'/connect',a.token,'POST',{page_ids:['111']})).data.results[0].ok,true);
 const other=await f.login(b.token);
 assert.equal((await f.request('/v1/flows/'+other.id+'/connect',b.token,'POST',{page_ids:['111']})).data.results[0].ok,false);
 assert.equal((await f.request('/v1/flows/'+other.id+'/connect',b.token,'POST',{page_ids:['222']})).data.results[0].ok,true);
 const publicFlow=JSON.stringify((await f.request('/v1/flows/'+login.id,a.token)).data);
 assert.ok(!publicFlow.includes('PAGE-A'));assert.ok(!publicFlow.includes('APP-SECRET'));
 const own=(await f.request('/v1/pages',a.token)).data.pages;assert.deepEqual(own.map(p=>p.id),['111']);assert.ok(!JSON.stringify(own).includes('APP-SECRET'));
 assert.equal((await f.event('111','m1',false)).status,403);assert.equal((await f.event('111')).status,200);await f.event('111');await f.event('222');
 const events=(await f.request('/v1/events',a.token)).data.events;assert.equal(events.length,1);assert.equal(events[0].page,'111');
 await f.request('/v1/events/ack',b.token,'POST',{ids:[events[0].id]});assert.equal((await f.request('/v1/events',a.token)).data.events.length,1);
 assert.ok(!f.app.db.prepare('SELECT payload FROM events LIMIT 1').get().payload.includes('PRIVATE MESSAGE'));
 assert.ok(!f.app.db.prepare('SELECT secret FROM pages LIMIT 1').get().secret.includes('PAGE-A'));
 await f.request('/v1/pages/111',b.token,'DELETE');assert.equal((await f.request('/v1/pages',a.token)).data.pages.length,1);
 await f.restart();assert.equal((await f.request('/v1/events',a.token)).data.events.length,1);
 await f.request('/v1/events/ack',a.token,'POST',{ids:[events[0].id]});assert.equal((await f.request('/v1/events',a.token)).data.events.length,0);
 await f.event('111','expires');f.advance(8*86400000);assert.equal((await f.request('/v1/events',a.token)).data.events.length,0);
 f.app.revokeTenant(a.id);assert.equal((await f.request('/v1/pages',a.token)).status,401);
});
test('Failed subscription does not claim a Page, OAuth expires and shared registration retries',async t=>{
 const f=await fixture(t),a=f.tenant('A'),b=f.tenant('B'),login=await f.login(a.token);
 f.breakMeta(true);const failed=await f.request('/v1/flows/'+login.id+'/connect',a.token,'POST',{page_ids:['111']});assert.equal(failed.data.results[0].ok,false);assert.ok(!JSON.stringify(failed).includes('SECRET-ERROR'));
 f.breakMeta(false);const other=await f.login(b.token);assert.equal((await f.request('/v1/flows/'+other.id+'/connect',b.token,'POST',{page_ids:['111']})).data.results[0].ok,true);
 f.advance(600001);assert.equal((await f.request('/v1/flows/'+other.id,b.token)).status,410);
});
test('Local Choibox receives queued events once, keeps App Secret out, sends proof and releases deleted channels',async t=>{
 const f=await fixture(t),tenant=f.tenant('Customer'),dir=mkdtempSync(join(tmpdir(),'choibox-customer-'));
 writeFileSync(join(dir,'connect.json'),JSON.stringify({url:'https://connect.example.test',token:tenant.token}),{mode:0o600});
 const graphCalls=[],app=createApp({dataDir:dir,connectTransport:f.transport,connectPollMs:100000,transport:async(url,options)=>{graphCalls.push({url,options});return {message_id:'reply-id'};}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
 t.after(async()=>{await new Promise(r=>app.server.close(r));app.db.close();rmSync(dir,{recursive:true,force:true});});
 let cookie='',csrf='';async function request(p,method='GET',body){const r=await fetch(base+p,{method,headers:{'Content-Type':'application/json',cookie,'X-CSRF-Token':csrf},...(body?{body:JSON.stringify(body)}:{})});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return {status:r.status,data:await r.json()};}
 await request('/api/setup','POST',{name:'Admin',email:'admin@test.local',password:'password12345'});await request('/api/login','POST',{email:'admin@test.local',password:'password12345'});csrf=(await request('/api/me')).data.csrf;
 assert.equal((await request('/api/facebook/config')).data.shared,true);
 const login=(await request('/api/facebook/start','POST',{})).data,state=new URL(login.url).searchParams.get('state');await f.request('/oauth/facebook/callback?code=test&state='+state);
 assert.equal((await request('/api/facebook/flows/'+login.id+'/connect','POST',{page_ids:['111']})).data.results[0].ok,true);
 assert.ok(!JSON.stringify((await request('/api/state')).data).includes('PAGE-A'));
 await f.event('111');await app.shared.poll();assert.equal(app.db.prepare('SELECT count(*) n FROM messages').get().n,1);
 await f.event('111');await app.shared.poll();assert.equal(app.db.prepare('SELECT count(*) n FROM messages').get().n,1);
 assert.equal((await f.request('/v1/events',tenant.token)).data.events.length,0);
 const sent=await request('/api/conversations/1/send','POST',{text:'Reply',request_id:'one'});assert.equal(sent.data.status,'sent');
 assert.equal(new URL(graphCalls.at(-1).url).searchParams.get('appsecret_proof'),createHmac('sha256','APP-SECRET').update('PAGE-A').digest('hex'));
 assert.equal((await request('/api/channels/1','DELETE',{confirm:true})).status,200);await app.shared.poll();assert.equal(app.db.prepare('SELECT count(*) n FROM channels').get().n,0);
 assert.equal((await f.request('/v1/pages',tenant.token)).data.pages.length,0);
});
