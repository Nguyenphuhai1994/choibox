import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHmac} from 'node:crypto';
import {createBroker,connectFetch} from './core.mjs';

const scopes='pages_show_list,pages_messaging,pages_manage_metadata,pages_read_engagement,pages_read_user_content,pages_manage_engagement'.split(',');
function fixture(t,overrides={}){
 const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');t.after(()=>db.close());
 let now=Date.now(),broken=false;
 const options={db,transaction(fn){db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}},
  encryptionKey:'a'.repeat(64),adminToken:'b'.repeat(64),publicUrl:'https://connect.example.test',
  appId:'123',appSecret:'APP-SECRET',verifyToken:'VERIFY',clock:()=>now,
  transport:async(raw,options={})=>{
   const u=new URL(raw);assert.equal(u.hostname,'graph.facebook.com');
   if(u.pathname.endsWith('/oauth/access_token'))return {access_token:'USER-TOKEN'};
   if(u.pathname.endsWith('/me/permissions'))return {data:scopes.map(permission=>({permission,status:'granted'}))};
   if(u.pathname.endsWith('/me/accounts'))return {data:[{id:'111',name:'Page A',access_token:'PAGE-A'},{id:'222',name:'Page B',access_token:'PAGE-B'}]};
   if(u.pathname.endsWith('/subscribed_apps')){if(broken)throw Error('SECRET-ERROR');assert.ok(JSON.parse(options.body).appsecret_proof);return {success:true};}
   throw Error('Unexpected Graph request');
  }
 };
 Object.assign(options,overrides);let broker=createBroker(options);
 async function request(path,token,method='GET',body,headers={}){
  const r=await broker.handle(new Request('https://connect.example.test'+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}));
  const text=await r.text();let data;try{data=JSON.parse(text);}catch{data=text;}return {status:r.status,data};
 }
 async function login(token){
  const f=(await request('/v1/flows',token,'POST',{})).data;
  const state=new URL(f.url).searchParams.get('state');
  assert.equal((await request('/oauth/facebook/callback?code=test&state='+state)).status,200);
  return {...f,state};
 }
 async function event(page,mid='m1',signed=true){
  const body={object:'page',entry:[{id:page,messaging:[{message:{mid,text:'PRIVATE MESSAGE'}}]}]};
  return request('/webhooks/facebook',null,'POST',body,{'x-hub-signature-256':signed?'sha256='+createHmac('sha256','APP-SECRET').update(JSON.stringify(body)).digest('hex'):'bad'});
 }
 return {db,request,login,event,tenant:name=>broker.createTenant(name),restart(){broker=createBroker(options);},advance:n=>now+=n,breakMeta:v=>broken=v};
}

test('OAuth diagnostics identify the failed Graph stage without leaking credentials or raw errors',async t=>{
 const f=fixture(t,{transport:async()=>{throw Object.assign(Error('PRIVATE TOKEN AND GRAPH URL'),{httpStatus:400,metaCode:100,metaSubcode:36007});}});
 const a=f.tenant('A'),b=f.tenant('B'),login=await f.login(a.token);
 f.restart();
 const response=await f.request('/v1/flows/'+login.id,a.token);
 assert.equal(response.data.status,'failed');
 assert.deepEqual(response.data.diagnostic,{stage:'short_token',error_kind:'Error',http_status:400,meta_code:100,meta_subcode:36007});
 assert.ok(!JSON.stringify(response.data).includes('PRIVATE'));
 assert.equal((await f.request('/v1/flows/'+login.id,b.token)).status,410);
});

test('Graph transport retains numeric diagnostic codes but discards secret-bearing messages',async t=>{
 t.mock.method(globalThis,'fetch',async(url,options)=>{assert.equal(options.redirect,'manual');return new Response(JSON.stringify({error:{code:190,error_subcode:463,message:'PRIVATE TOKEN'}}),{status:400});});
 await assert.rejects(connectFetch('https://graph.facebook.com/v25.0/test'),e=>e.metaCode===190&&e.metaSubcode===463&&e.httpStatus===400&&!e.message.includes('PRIVATE'));
});

test('Graph transport rejects every redirect without forwarding credentials or calling another origin',async t=>{
 for(const status of [301,302,303,307,308]){
  let calls=0;
  const mocked=t.mock.method(globalThis,'fetch',async(url,options)=>{calls++;assert.equal(url,'https://graph.facebook.com/v25.0/oauth/access_token');assert.equal(options.redirect,'manual');return new Response(null,{status,headers:{Location:'https://other.example.test/token'}});});
  await assert.rejects(connectFetch('https://graph.facebook.com/v25.0/oauth/access_token',{headers:{Authorization:'Bearer PRIVATE'}}),e=>e.transportKind==='redirect_blocked'&&e.httpStatus===status);
  assert.equal(calls,1);mocked.mock.restore();
 }
});

test('Worker broker persists OAuth across eviction, rejects replay and separates customer credentials',async t=>{
 const f=fixture(t),a=f.tenant('A'),b=f.tenant('B');
 assert.equal((await f.request('/v1/pages')).status,401);
 const pending=(await f.request('/v1/flows',a.token,'POST',{})).data;
 f.restart();
 const state=new URL(pending.url).searchParams.get('state');
 assert.equal((await f.request('/oauth/facebook/callback?code=x&state='+state)).status,200);
 assert.equal((await f.request('/oauth/facebook/callback?code=x&state='+state)).status,410);
 f.restart();
 assert.equal((await f.request('/v1/flows/'+pending.id,a.token)).data.status,'ready');
 assert.equal((await f.request('/v1/flows/'+pending.id,b.token)).status,410);
 const connect=(id,token,ids)=>f.request('/v1/flows/'+id+'/connect',token,'POST',{page_ids:ids});
 assert.equal((await connect(pending.id,a.token,['111'])).data.results[0].ok,true);
 const second=await f.login(b.token);
 assert.equal((await connect(second.id,b.token,['111'])).data.results[0].ok,false);
 assert.equal((await connect(second.id,b.token,['222'])).data.results[0].ok,true);
 const publicFlow=JSON.stringify((await f.request('/v1/flows/'+pending.id,a.token)).data);
 assert.ok(!publicFlow.includes('TOKEN')&&!publicFlow.includes('PAGE-A'));
 assert.ok(!f.db.prepare('SELECT payload FROM flows LIMIT 1').get().payload.includes('PAGE-A'));
 assert.ok(!f.db.prepare('SELECT secret FROM pages LIMIT 1').get().secret.includes('PAGE-A'));
 assert.deepEqual((await f.request('/v1/pages',a.token)).data.pages.map(p=>p.id),['111']);
 await f.request('/v1/pages/111',b.token,'DELETE');
 assert.equal((await f.request('/v1/pages',a.token)).data.pages.length,1);
});

test('Worker queue verifies signatures, encrypts messages, survives restart and rejects stale/foreign acknowledgments',async t=>{
 const f=fixture(t),a=f.tenant('A'),b=f.tenant('B'),login=await f.login(a.token);
 await f.request('/v1/flows/'+login.id+'/connect',a.token,'POST',{page_ids:['111']});
 assert.equal((await f.event('111','m1',false)).status,403);
 assert.equal((await f.event('111')).status,200);await f.event('111');
 f.restart();
 const events=(await f.request('/v1/events',a.token)).data.events;
 assert.equal(events.length,1);
 assert.ok(!f.db.prepare('SELECT payload FROM events').get().payload.includes('PRIVATE MESSAGE'));
 await f.request('/v1/events/ack',b.token,'POST',{ids:[events[0].id]});
 assert.equal((await f.request('/v1/events',a.token)).data.events.length,1);
 await f.request('/v1/events/ack',a.token,'POST',{ids:[events[0].id]});
 await f.event('111','m2');
 const newer=(await f.request('/v1/events',a.token)).data.events;
 assert.ok(newer[0].id>events[0].id);
 await f.request('/v1/events/ack',a.token,'POST',{ids:[events[0].id]});
 assert.equal((await f.request('/v1/events',a.token)).data.events.length,1);
 f.advance(8*86400000);
 assert.equal((await f.request('/v1/events',a.token)).data.events.length,0);
});

test('Worker provisioning requires operator key; failed subscriptions can retry and expired OAuth is rejected',async t=>{
 const f=fixture(t);
 assert.equal((await f.request('/admin/tenants',null,'POST',{name:'A'})).status,401);
 const provision=(await f.request('/admin/tenants','b'.repeat(64),'POST',{name:'A'}));
 assert.equal(provision.status,201);const a=provision.data;
 assert.equal((await f.request('/v1/status',a.token)).data.workspace,a.workspace);
 const login=await f.login(a.token);
 f.breakMeta(true);
 assert.equal((await f.request('/v1/flows/'+login.id+'/connect',a.token,'POST',{page_ids:['111']})).data.results[0].ok,false);
 assert.equal(f.db.prepare('SELECT count(*) n FROM pages').get().n,0);
 f.breakMeta(false);
 assert.equal((await f.request('/v1/flows/'+login.id+'/connect',a.token,'POST',{page_ids:['111']})).data.results[0].ok,true);
 f.advance(600001);
 assert.equal((await f.request('/v1/flows/'+login.id,a.token)).status,410);
});

test('Encrypted migration preserves existing credentials and queued events, retries safely and refuses overwriting customers',async t=>{
 const source=fixture(t),target=fixture(t),a=source.tenant('Existing customer');
 const login=await source.login(a.token);
 await source.request('/v1/flows/'+login.id+'/connect',a.token,'POST',{page_ids:['111']});
 await source.event('111');
 const snapshot={id:'migration-test-20261021',...Object.fromEntries(['tenants','pages','events'].map(table=>[table,source.db.prepare('SELECT * FROM '+table).all()]))};
 assert.equal((await target.request('/admin/import',a.token,'POST',snapshot)).status,401);
 const broken=structuredClone(snapshot);broken.pages[0].secret='invalid';
 assert.equal((await target.request('/admin/import','b'.repeat(64),'POST',broken)).status,400);
 assert.equal(target.db.prepare('SELECT count(*) n FROM tenants').get().n,0);
 const imported=await target.request('/admin/import','b'.repeat(64),'POST',snapshot);
 assert.deepEqual(imported.data,{ok:true,tenants:1,pages:1,events:1});
 assert.equal((await target.request('/admin/import','b'.repeat(64),'POST',snapshot)).status,200);
 assert.equal((await target.request('/admin/import','b'.repeat(64),'POST',{...snapshot,id:'different-import'})).status,409);
 target.restart();
 assert.equal((await target.request('/v1/status',a.token)).data.workspace,a.id);
 assert.equal((await target.request('/v1/pages',a.token)).data.pages[0].secret.access_token,'PAGE-A');
 const previous=(await target.request('/v1/events',a.token)).data.events[0];
 await target.request('/v1/events/ack',a.token,'POST',{ids:[previous.id]});
 await target.event('111','after-migration');
 assert.ok((await target.request('/v1/events',a.token)).data.events[0].id>previous.id);
});
