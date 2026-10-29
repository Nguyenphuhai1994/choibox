import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from './server.mjs';

function fakeNetwork({account='888000',holdSubmit=false,uncertain=false,mediaData=null}={}){
 const instances=[];let release;
 function factory(options){
  const s={calls:[],closed:false,directory:options.directory,emit:(kind,data)=>options.onEvent(kind,data)};
  s.call=async(method,params={})=>{
   s.calls.push({method,params});
   if(method==='hello')return {protocol:1,name:'choibox-facebook-personal'};
   if(method==='login.start')return {step:{type:'user_input',instructions:'Facebook test sign-in',user_input:{fields:[{id:'username',type:'username'},{id:'password',type:'password'}]}}};
   if(method==='login.submit'){
    if(holdSubmit)await new Promise(r=>release=r);
    return {complete:true,cookies:{c_user:account,xs:'private-session-cookie',datr:'private-device-cookie'}};
   }
   if(method==='connect'){assert.ok(params.cookies.xs);s.emit('state',{connected:true});return {id:account,name:'Tài khoản thử',cookies:params.cookies};}
   if(method==='state')return {connected:true,encrypted:true};
   if(method==='encrypted.connect'){mkdirSync(options.directory,{recursive:true});writeFileSync(join(options.directory,'test-device-key'),'fake-key');return {connected:true};}
   if(method==='media.prepare'){if(!mediaData)throw Error('no media');s.media=mediaData;return {token:'a'.repeat(32),size:mediaData.length,mime:params.media.mime};}
   if(method==='media.chunk'){const end=Math.min(params.offset+256*1024,s.media.length);return {data:s.media.subarray(params.offset,end).toString('base64'),next:end,done:end===s.media.length};}
   if(method==='media.release'){s.media=null;return {ok:true};}
   if(method==='send'){if(uncertain)throw Object.assign(Error('private server detail'),{code:'SEND_UNCONFIRMED'});return {message_id:'out-'+s.calls.filter(c=>c.method==='send').length};}
   throw Error('unexpected '+method);
  };
  s.close=()=>{s.closed=true;};instances.push(s);return s;
 }
 return {factory,instances,release:()=>release?.()};
}
async function client(base,email,password){
 let cookie='',csrf='';
 async function call(p,method='GET',data){
  const r=await fetch(base+p,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{})},...(data?{body:JSON.stringify(data)}:{})});
  const set=r.headers.get('set-cookie');if(set)cookie=set.split(';')[0];
  return {status:r.status,data:await r.json()};
 }
 if(email){assert.equal((await call('/api/login','POST',{email,password})).status,200);csrf=(await call('/api/me')).data.csrf;}
 return {call};
}
async function fixture(t,network){
 const dir=mkdtempSync(join(tmpdir(),'choibox-fbp-')),app=createApp({dataDir:dir,facebookFactory:network.factory});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
 t.after(async()=>{await new Promise(r=>app.server.close(r));app.db.close();rmSync(dir,{recursive:true,force:true});});
 const guest=await client(base);await guest.call('/api/setup','POST',{name:'Admin',email:'fbp@test.local',password:'test-password-long'});
 return {app,base,admin:await client(base,'fbp@test.local','test-password-long')};
}
async function connect(admin){
 const start=await admin.call('/api/facebook-personal/start','POST',{});
 assert.equal(start.status,201);assert.equal(start.data.status,'waiting');
 const result=await admin.call('/api/facebook-personal/flows/'+start.data.id+'/submit','POST',{input:{username:'test',password:'not-stored-password'}});
 assert.equal(result.status,200);assert.equal(result.data.status,'connected');return {start,result};
}
test('personal Facebook: encrypted credentials, grants, receive dedupe, confirmed send, pause and remove',async t=>{
 const network=fakeNetwork(),{app,base,admin}=await fixture(t,network);
 const {start,result}=await connect(admin);const ch=app.db.prepare("SELECT * FROM channels WHERE provider='facebook_personal'").get(),s=network.instances[0];
 assert.ok(ch.secret);assert.ok(!ch.secret.includes('private-session-cookie'));assert.ok(!ch.secret.includes('not-stored-password'));
 assert.ok(!JSON.stringify([start,result]).includes('private-session-cookie'));
 const peer={id:'in-1',peer:'222000',name:'Khách thử',text:'Xin chào',time:Date.now(),self:false,encrypted:true};
 s.emit('message',peer);s.emit('message',peer);
 const conv=app.db.prepare('SELECT * FROM conversations WHERE channel_id=?').get(ch.id);
 assert.equal(conv.unread,1);assert.equal(conv.facebook_encrypted,1);assert.equal(app.db.prepare('SELECT COUNT(*) n FROM messages WHERE conversation_id=?').get(conv.id).n,1);
 const uid=(await admin.call('/api/users','POST',{name:'Agent',email:'fb-agent@test.local',password:'test-password-long',role:'agent'})).data.id;
 let agent=await client(base,'fb-agent@test.local','test-password-long');
 assert.equal((await agent.call('/api/state')).data.channels.length,0);
 assert.equal((await agent.call('/api/conversations/'+conv.id+'/send','POST',{text:'blocked',request_id:'blocked'})).status,403);
 await admin.call('/api/users/'+uid,'PATCH',{grants:[{channel_id:ch.id,can_reply:true}]});
 agent=await client(base,'fb-agent@test.local','test-password-long');
 assert.equal((await agent.call('/api/state')).data.channels[0].configured,true);
 const request={text:'Trả lời thử',request_id:'reply-1'};
 assert.equal((await agent.call('/api/conversations/'+conv.id+'/send','POST',request)).data.status,'sent');
 await agent.call('/api/conversations/'+conv.id+'/send','POST',request);
 assert.equal(s.calls.filter(c=>c.method==='send').length,1);
 assert.equal(s.calls.find(c=>c.method==='send').params.encrypted,true);
 await admin.call('/api/channels/'+ch.id,'PATCH',{enabled:false});assert.equal(s.closed,true);
 s.emit('message',{...peer,id:'after-pause'});assert.equal(app.db.prepare('SELECT COUNT(*) n FROM messages WHERE external_id=?').get('after-pause').n,0);
 const del=await admin.call('/api/channels/'+ch.id,'DELETE',{confirm:true});assert.equal(del.status,200);assert.equal(existsSync(s.directory),false);
 assert.equal(app.db.prepare('SELECT COUNT(*) n FROM channels').get().n,0);
});
test('cancel or logout during authentication never saves a late successful account',async t=>{
 const network=fakeNetwork({holdSubmit:true}),{app,admin}=await fixture(t,network);
 const start=(await admin.call('/api/facebook-personal/start','POST',{})).data;
 const pending=admin.call('/api/facebook-personal/flows/'+start.id+'/submit','POST',{input:{username:'test',password:'not-stored'}});
 for(let i=0;i<50&&!network.instances[0].calls.some(c=>c.method==='login.submit');i++)await new Promise(r=>setTimeout(r,5));
 await admin.call('/api/facebook-personal/flows/'+start.id,'DELETE');
 network.release();const result=await pending;
 assert.equal(result.data.status,'cancelled');assert.equal(network.instances[0].closed,true);
 assert.equal(app.db.prepare("SELECT COUNT(*) n FROM channels WHERE provider='facebook_personal'").get().n,0);
});
test('Facebook personal uncertainty is never retried automatically and errors do not expose secrets',async t=>{
 const network=fakeNetwork({uncertain:true}),{app,admin}=await fixture(t,network);await connect(admin);
 const s=network.instances[0];s.emit('message',{id:'in',peer:'222',name:'Khách',text:'hi',time:Date.now(),encrypted:true});
 const conv=app.db.prepare('SELECT * FROM conversations').get();
 const a=await admin.call('/api/conversations/'+conv.id+'/send','POST',{text:'test',request_id:'uncertain'});
 assert.equal(a.data.status,'failed');assert.ok(!JSON.stringify(a).includes('private server detail'));
 await admin.call('/api/conversations/'+conv.id+'/send','POST',{text:'test',request_id:'uncertain'});
 assert.equal(s.calls.filter(c=>c.method==='send').length,1);
});
test('personal login flow is owner-bound and unavailable to non-admin users',async t=>{
 const network=fakeNetwork(),{app,base,admin}=await fixture(t,network);
 const start=(await admin.call('/api/facebook-personal/start','POST',{})).data;
 await admin.call('/api/users','POST',{name:'Viewer',email:'fb-viewer@test.local',password:'test-password-long',role:'viewer'});
 const viewer=await client(base,'fb-viewer@test.local','test-password-long');
 assert.equal((await viewer.call('/api/facebook-personal/flows/'+start.id)).status,403);
 assert.equal((await viewer.call('/api/facebook-personal/start','POST',{})).status,403);
 await admin.call('/api/logout','POST',{});
 assert.equal(network.instances[0].closed,true);
 assert.equal(app.db.prepare('SELECT COUNT(*) n FROM channels').get().n,0);
});

test('restart restores encrypted cookies without requesting password again; foreign restored account is rejected',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'choibox-fbp-restart-'));
 let app;const net=fakeNetwork();
 async function launch(factory){
  app=createApp({dataDir:dir,facebookFactory:factory});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  return 'http://127.0.0.1:'+app.server.address().port;
 }
 t.after(async()=>{if(app){await new Promise(r=>app.server.close(r));app.db.close();}rmSync(dir,{recursive:true,force:true});});
 let base=await launch(net.factory),guest=await client(base);
 await guest.call('/api/setup','POST',{name:'Admin',email:'restart@test.local',password:'test-password-long'});
 await connect(await client(base,'restart@test.local','test-password-long'));
 await new Promise(r=>app.server.close(r));app.db.close();app=null;
 const second=fakeNetwork();base=await launch(second.factory);
 for(let i=0;i<40&&!app.db.prepare('SELECT verified FROM channels').get()?.verified;i++)await new Promise(r=>setTimeout(r,5));
 assert.equal(second.instances[0].calls.filter(c=>c.method.startsWith('login.')).length,0);
 assert.equal(second.instances[0].calls.find(c=>c.method==='connect').params.cookies.xs,'private-session-cookie');
 assert.equal(app.db.prepare('SELECT verified FROM channels').get().verified,1);
 await new Promise(r=>app.server.close(r));app.db.close();app=null;
 const wrong=fakeNetwork({account:'999000'});await launch(wrong.factory);
 for(let i=0;i<40&&!wrong.instances[0]?.closed;i++)await new Promise(r=>setTimeout(r,5));
 assert.equal(app.db.prepare('SELECT verified FROM channels').get().verified,0);
 assert.equal(wrong.instances[0].closed,true);
 assert.equal(wrong.instances[0].calls.some(c=>c.method==='encrypted.connect'),false);
});

test('encrypted images open inline on demand without exposing media keys, and obey conversation grants',async t=>{
 const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
 const network=fakeNetwork({mediaData:image}),{app,base,admin}=await fixture(t,network);await connect(admin);const s=network.instances[0];
 s.emit('message',{id:'encrypted-photo',peer:'444',name:'Media test',text:'[Ảnh đính kèm]',time:Date.now(),encrypted:true,media:{encrypted:true,kind:'image',mime:'image/png',name:'test.png',size:image.length,integral:{mediaKey:'PRIVATE-MEDIA-KEY',directPath:'/private-media-path'}}});
 const m=app.db.prepare('SELECT attachment_id FROM messages WHERE external_id=?').get('encrypted-photo');assert.ok(m.attachment_id);
 const record=app.db.prepare('SELECT * FROM attachments WHERE id=?').get(m.attachment_id);
 assert.ok(!record.source.includes('PRIVATE-MEDIA-KEY'));assert.equal(record.cache_disk,0);
 assert.equal(s.calls.some(c=>c.method==='media.prepare'),false);
 await admin.call('/api/users','POST',{name:'No grant',email:'media-no-grant@test.local',password:'test-password-long',role:'viewer'});
 const other=await client(base,'media-no-grant@test.local','test-password-long');
 assert.equal((await other.call('/api/attachments/'+m.attachment_id+'/info')).status,403);
 assert.equal(s.calls.some(c=>c.method==='media.prepare'),false);
 const info=await admin.call('/api/attachments/'+m.attachment_id+'/info');assert.equal(info.status,200);assert.equal(info.data.mime,'image/png');
 assert.ok(!JSON.stringify(info.data).includes('PRIVATE-MEDIA-KEY'));assert.ok(!JSON.stringify(info.data).includes('/private-media-path'));
 assert.equal(s.calls.filter(c=>c.method==='media.prepare').length,1);assert.equal(s.calls.filter(c=>c.method==='media.release').length,1);
 const messages=(await admin.call('/api/conversations/'+record.conversation_id+'/messages')).data;
 assert.equal(messages.find(m=>m.external_id==='encrypted-photo').attachment.mime,'image/png');
});
test('received video supports Range playback while sender deletion cannot recreate a cached attachment',async t=>{
 const video=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(70)]);
 const network=fakeNetwork({mediaData:video}),{app,base,admin}=await fixture(t,network);await connect(admin);const s=network.instances[0];
 const event={id:'encrypted-video',peer:'555',name:'Video test',text:'[Video đính kèm]',time:Date.now(),encrypted:true,media:{encrypted:true,kind:'video',mime:'video/mp4',name:'test.mp4',size:video.length,integral:{mediaKey:'PRIVATE-VIDEO-KEY'}}};
 s.emit('message',event);const m=app.db.prepare('SELECT * FROM messages WHERE external_id=?').get(event.id);assert.ok(m.attachment_id);
 const info=await admin.call('/api/attachments/'+m.attachment_id+'/info');assert.equal(info.status,200);assert.equal(info.data.mime,'video/mp4');
 const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'fbp@test.local',password:'test-password-long'})});
 const cookie=login.headers.get('set-cookie').split(';')[0];
 const range=await fetch(base+'/api/attachments/'+m.attachment_id,{headers:{Cookie:cookie,Range:'bytes=4-11'}});
 assert.equal(range.status,206);assert.equal(range.headers.get('content-range'),'bytes 4-11/'+video.length);assert.deepEqual(Buffer.from(await range.arrayBuffer()),video.subarray(4,12));
 await admin.call('/api/messages/'+m.id+'/moderate','POST',{action:'local-delete',confirm:true});
 s.emit('message',event);
 assert.equal((await admin.call('/api/attachments/'+m.attachment_id+'/info')).status,404);
});

test('packaged connector resolves outside app.asar while source builds retain their native path',async()=>{const {facebookBinaryRoot}=await import('./facebook-personal.mjs');assert.equal(facebookBinaryRoot('/Applications/Choibox.app/Contents/Resources/app.asar'),'/Applications/Choibox.app/Contents/Resources/app.asar.unpacked/connectors/facebook-personal/bin');assert.equal(facebookBinaryRoot('/source/choibox'),'/source/choibox/connectors/facebook-personal/bin');});
