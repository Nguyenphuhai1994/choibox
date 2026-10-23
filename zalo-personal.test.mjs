import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from './server.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
const settle=async()=>{for(let i=0;i<6;i++)await new Promise(r=>setImmediate(r));};
function mockZalo(){
 const pending=[],restored=[],apis=[];let serial=1000;
 function account(uid='111'){
  const listener=new EventEmitter();let stopped=0,history=0;
  listener.start=()=>queueMicrotask(()=>listener.emit('connected'));listener.stop=()=>{stopped++;listener.emit('closed',1000);};listener.requestOldMessages=()=>{history++;};
  const sent=[],credentials={cookie:[{key:'zpw_sek',value:'private-cookie-'+uid,domain:'zalo.me'}],imei:'private-imei-'+uid,userAgent:'Choibox test UA'};
  const api={listener,sent,credentials,get stopped(){return stopped;},get history(){return history;},getContext:()=>({...credentials,uid,cookie:{toJSON:()=>({cookies:credentials.cookie})}}),fetchAccountInfo:async()=>({profile:{displayName:'Tài khoản '+uid}}),getUserInfo:async id=>({changed_profiles:{[id]:{displayName:'Khách '+id,avatar:'https://s120-ava-talk.zadn.vn/avatar.png'}}}),sendMessage:async(content,threadId,type)=>{sent.push({content,threadId,type});const msgId=String(++serial);listener.emit('message',{type,threadId,isSelf:true,data:{msgId,ts:Date.now(),content:typeof content==='string'?content:{title:'Tệp'},dName:'Tôi'}});return {message:typeof content==='string'?{msgId}:null,attachment:typeof content==='string'?[]:[{msgId}]};}};
  apis.push(api);return api;
 }
 const factory=()=>({loginQR:async(options,callback)=>new Promise((resolve,reject)=>{const flow={callback,resolve,reject,aborted:false};flow.abort=()=>{flow.aborted=true;reject(Error('Sensitive internal error private-cookie'));};pending.push(flow);queueMicrotask(()=>callback({type:0,data:{image:png.toString('base64'),token:'private-qr-token',code:'private-qr-code'},actions:{abort:flow.abort}}));}),login:async credentials=>{restored.push(credentials);const uid=credentials.imei.split('-').at(-1);return account(uid);}});
 function complete(flow=pending.at(-1),uid='111'){const api=account(uid);flow.callback({type:2,data:{display_name:'Tài khoản '+uid},actions:{abort:flow.abort}});flow.callback({type:4,data:api.credentials});flow.resolve(api);return api;}
 return {factory,pending,restored,apis,account,complete};
}
async function fixture(t,settings={}){
 const dir=mkdtempSync(join(tmpdir(),'choibox-zalo-personal-')),mock=mockZalo(),images=[];
 let app=createApp({dataDir:dir,zaloFactory:mock.factory,transport:async()=>{throw Error('Personal Zalo must not call OA or Meta');},fetchImage:async url=>{images.push(url);return new Response(png,{headers:{'content-type':'image/png'}});},...settings});
 let base='';async function listen(){await new Promise(r=>app.server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+app.server.address().port;}await listen();
 async function client(email,password='long-password-123'){
  let cookie='',csrf='';const call=async(p,method='GET',body,headers={})=>{const r=await fetch(base+'/api'+p,{method,headers:{cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return {status:r.status,data:await r.json()};};
  if(email){assert.equal((await call('/login','POST',{email,password})).status,200);csrf=(await call('/me')).data.csrf;}
  const upload=async(id,name,data=png)=>{const r=await fetch(base+'/api/conversations/'+id+'/attachments',{method:'POST',headers:{cookie,'X-CSRF-Token':csrf,'Content-Type':'application/octet-stream','X-File-Name':encodeURIComponent(name)},body:data});return {status:r.status,data:await r.json()};};
  const raw=p=>fetch(base+'/api'+p,{headers:{cookie}});
  return {call,upload,raw};
 }
 t.after(async()=>{await new Promise(r=>app.server.close(r));app.db.close();rmSync(dir,{recursive:true,force:true});});
 const guest=await client();await guest.call('/setup','POST',{name:'Admin',email:'admin@zalo.test',password:'long-password-123'});const admin=await client('admin@zalo.test');
 const start=async(channel_id)=>{const r=await admin.call('/zalo-personal/start','POST',{channel_id});assert.equal(r.status,201);await settle();return r.data.id;};
 return {get app(){return app;},mock,images,client,guest,admin,start,dir,async reopen(beforeOpen){await new Promise(r=>app.server.close(r));beforeOpen?.(app.db);app.db.close();app=createApp({dataDir:dir,zaloFactory:mock.factory});await listen();await settle();}};
}
const incoming=(id='10',peer='222',body='Xin chào')=>({type:0,threadId:peer,isSelf:false,data:{msgId:id,ts:Date.now(),content:body,dName:'Khách thật'}});

test('Lazy media sources stay encrypted, file reads enforce grants before fetching, and only admin configures storage',async t=>{
 const f=await fixture(t);await f.start();const api=f.mock.complete();await settle();const e=incoming('771');e.data.msgType='chat.photo';e.data.content={href:'https://s120-ava-talk.zadn.vn/customer-secret.png',title:'Ảnh khách gửi'};api.listener.emit('message',e);await settle();
 const c=(await f.admin.call('/state')).data.conversations[0],m=(await f.admin.call('/conversations/'+c.id+'/messages')).data[0],a=f.app.db.prepare('SELECT * FROM attachments WHERE id=?').get(m.attachment_id);assert.ok(a);assert.equal(a.data.length,0);assert.equal(a.cache_disk,0);assert.ok(!a.source.includes('customer-secret'));assert.ok(!JSON.stringify(m).includes('source'));assert.ok(!f.images.some(x=>x.includes('customer-secret')));
 assert.equal((await f.guest.raw('/attachments/'+a.id+'/info')).status,401);
 const uid=(await f.admin.call('/users','POST',{name:'Viewer',email:'lazy-view@zalo.test',password:'long-password-123',role:'viewer'})).data.id;let viewer=await f.client('lazy-view@zalo.test');assert.equal((await viewer.raw('/attachments/'+a.id)).status,403);assert.ok(!f.images.some(x=>x.includes('customer-secret')));
 await f.admin.call('/users/'+uid,'PATCH',{grants:[{channel_id:c.channel_id,can_reply:false}]});viewer=await f.client('lazy-view@zalo.test');assert.equal((await viewer.call('/storage')).status,403);assert.equal((await viewer.call('/storage','PATCH',{days:1,max_bytes:30*1024**2})).status,403);
 const info=await viewer.call('/attachments/'+a.id+'/info');assert.equal(info.status,200);assert.equal(info.data.cached,true);assert.equal(info.data.mime,'image/png');assert.equal(f.images.filter(x=>x.includes('customer-secret')).length,1);assert.equal((await viewer.raw('/attachments/'+a.id)).status,200);assert.equal(f.images.filter(x=>x.includes('customer-secret')).length,1);
 const cached=f.app.db.prepare('SELECT * FROM attachments WHERE id=?').get(a.id);assert.equal(cached.data.length,0);assert.equal(cached.cache_disk,1);assert.deepEqual(readFileSync(join(f.dir,'media-cache',a.id)),png);
 assert.equal((await f.admin.call('/storage')).data.max_bytes,2*1024**3);assert.equal((await f.admin.call('/storage','PATCH',{days:1,max_bytes:30*1024**2},{'X-CSRF-Token':'bad'})).status,403);assert.equal((await f.admin.call('/storage','PATCH',{days:0,max_bytes:30*1024**2})).status,400);assert.equal((await f.admin.call('/storage','PATCH',{days:1,max_bytes:30*1024**2})).status,200);
 assert.equal((await f.admin.call('/storage/cleanup','POST',{})).status,400);assert.equal((await f.admin.call('/storage/cleanup','POST',{confirm:true})).status,200);
});

test('Group sender photos are cached per account, deduplicated and protected by conversation grants',async t=>{
 const f=await fixture(t);await f.start();const api=f.mock.complete();await settle();
 api.getGroupInfo=async id=>({gridInfoMap:{[id]:{name:'Nhóm thử'}}});
 api.listener.emit('message',{type:1,threadId:'888',isSelf:false,data:{msgId:'901',uidFrom:'222',dName:'Lan',content:'Chào nhóm',ts:Date.now()}});await settle();
 const c=(await f.admin.call('/state')).data.conversations[0],m=(await f.admin.call('/conversations/'+c.id+'/messages')).data[0];let lookups=0;
 api.getUserInfo=async id=>{lookups++;return {changed_profiles:{[id+'_0']:{displayName:'Lan',avatar:'https://s120-ava-talk.zadn.vn/member.png'}}};};
 const photos=await Promise.all([f.admin.raw('/messages/'+m.id+'/avatar'),f.admin.raw('/messages/'+m.id+'/avatar')]);
 for(const r of photos){assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await r.arrayBuffer()),png);assert.match(r.headers.get('cache-control'),/private/);}
 assert.equal(lookups,1);assert.equal((await f.admin.raw('/messages/'+m.id+'/avatar')).status,200);assert.equal(lookups,1);
 assert.equal((await f.guest.raw('/messages/'+m.id+'/avatar')).status,401);
 const id=(await f.admin.call('/users','POST',{name:'Agent',email:'photos@zalo.test',password:'long-password-123',role:'agent'})).data.id;let agent=await f.client('photos@zalo.test');
 assert.equal((await agent.raw('/messages/'+m.id+'/avatar')).status,403);
 await f.admin.call('/users/'+id,'PATCH',{grants:[{channel_id:c.channel_id,can_reply:false}]});agent=await f.client('photos@zalo.test');assert.equal((await agent.raw('/messages/'+m.id+'/avatar')).status,200);
 await f.admin.call('/users/'+id,'PATCH',{grants:[]});agent=await f.client('photos@zalo.test');assert.equal((await agent.raw('/messages/'+m.id+'/avatar')).status,403);
 await f.admin.call('/messages/'+m.id+'/moderate','POST',{action:'local-delete',confirm:true});assert.equal((await f.admin.raw('/messages/'+m.id+'/avatar')).status,404);
 await f.admin.call('/channels/'+c.channel_id,'DELETE',{confirm:true});assert.equal(f.app.db.prepare('SELECT COUNT(*) n FROM zalo_author_avatars').get().n,0);
});

test('Personal Zalo QR is admin/CSRF/session bound, redacted and cancellable',async t=>{
 const f=await fixture(t),{admin,mock}=f;
 const uid=(await admin.call('/users','POST',{name:'Agent',email:'agent@zalo.test',password:'long-password-123',role:'agent'})).data.id,agent=await f.client('agent@zalo.test');
 assert.equal((await agent.call('/zalo-personal/start','POST',{})).status,403);
 assert.equal((await admin.call('/zalo-personal/start','POST',{}, {'X-CSRF-Token':'wrong'})).status,403);
 const id=await f.start(),r=await admin.call('/zalo-personal/flows/'+id);assert.equal(r.data.status,'qr');assert.ok(r.data.qr.startsWith('data:image/png;base64,'));assert.ok(!JSON.stringify(r).includes('private-'));
 const other=await f.client('admin@zalo.test');assert.equal((await other.call('/zalo-personal/flows/'+id)).status,404);assert.equal((await agent.call('/zalo-personal/flows/'+id)).status,403);
 assert.equal((await admin.call('/zalo-personal/flows/'+id,'DELETE',{})).status,200);assert.equal(mock.pending[0].aborted,true);
 mock.complete(mock.pending[0]);await settle();assert.equal(f.app.db.prepare('SELECT COUNT(*) n FROM channels').get().n,0);
 const second=await f.start();await admin.call('/logout','POST',{});assert.equal(mock.pending.at(-1).aborted,true);assert.equal((await other.call('/zalo-personal/flows/'+second)).status,404);
 assert.ok(uid>0);
});

test('Multiple personal Zalo accounts share only granted chats; send/attachments/echoes are idempotent',async t=>{
 const f=await fixture(t),{admin,mock}=f;
 await f.start();const first=mock.complete();await settle();assert.equal(first.history,2);
 await f.start();const second=mock.complete(undefined,'333');await settle();
 const channels=(await admin.call('/state')).data.channels;assert.equal(channels.length,2);assert.ok(channels.every(c=>c.provider==='zalo_personal'&&c.verified===1));
 const disk=f.app.db.prepare('SELECT secret FROM channels').all();assert.ok(!JSON.stringify(disk).includes('private-'));assert.ok(!readFileSync(join(f.dir,'inbox.sqlite')).includes(Buffer.from('private-cookie')));
 first.listener.emit('message',incoming());first.listener.emit('message',incoming());second.listener.emit('message',incoming('10','222','Tài khoản khác'));await settle();
 const state=(await admin.call('/state')).data;assert.equal(state.conversations.length,2);assert.equal(state.conversations[0].unread,1);assert.ok(!JSON.stringify(state).includes('private-'));assert.ok(state.conversations.every(c=>c.has_avatar));
 const c=state.conversations.find(c=>c.channel_id===channels[0].id),uid=(await admin.call('/users','POST',{name:'Agent',email:'agent@zalo.test',password:'long-password-123',role:'agent'})).data.id;
 await admin.call('/users/'+uid,'PATCH',{grants:[{channel_id:c.channel_id,can_reply:false}]});let agent=await f.client('agent@zalo.test');assert.equal((await agent.call('/state')).data.conversations.length,1);assert.equal((await agent.call('/conversations/'+c.id+'/send','POST',{text:'Không được',request_id:'no-permission'})).status,403);
 await admin.call('/users/'+uid,'PATCH',{grants:[{channel_id:c.channel_id,can_reply:true}]});agent=await f.client('agent@zalo.test');
 const body={text:'Chào bạn',request_id:'once'},message=(await agent.call('/conversations/'+c.id+'/send','POST',body)).data;assert.equal(message.status,'sent');assert.equal(first.sent.length,1);assert.equal(first.sent[0].threadId,'222');assert.equal((await agent.call('/conversations/'+c.id+'/send','POST',body)).data.id,message.id);assert.equal(first.sent.length,1);assert.equal(f.app.db.prepare('SELECT COUNT(*) n FROM messages WHERE external_id=?').get(message.external_id).n,1);
 const file=(await agent.upload(c.id,'anh.png')).data,uploaded=(await agent.call('/conversations/'+c.id+'/send','POST',{attachment_id:file.id,request_id:'file-once'})).data;assert.equal(uploaded.status,'sent');assert.equal(first.sent.at(-1).content.attachments.metadata.width,1);assert.ok(Buffer.isBuffer(first.sent.at(-1).content.attachments.data));
 first.listener.emit('seen_messages',[{type:0,isSelf:false,threadId:'222',data:{msgId:message.external_id}}]);assert.equal(f.app.db.prepare('SELECT status FROM messages WHERE id=?').get(message.id).status,'read');
 assert.equal((await admin.call('/channels/'+c.channel_id+'/credentials','POST',{access_token:'bad'})).status,400);
});

test('Pause, resume, duplicate sessions, deletion and encrypted startup restoration do not resurrect channels',async t=>{
 const f=await fixture(t),{admin,mock}=f;await f.start();const original=mock.complete();await settle();let ch=(await admin.call('/state')).data.channels[0];
 original.listener.emit('message',incoming());await settle();await admin.call('/channels/'+ch.id,'PATCH',{enabled:false});original.listener.emit('message',incoming('30'));assert.equal(f.app.db.prepare('SELECT COUNT(*) n FROM messages').get().n,1);assert.ok(original.stopped);
 await admin.call('/channels/'+ch.id,'PATCH',{enabled:true});await settle();assert.equal(mock.restored.length,1);let live=mock.apis.at(-1);
 // A late close or message from the old API must not break its replacement.
 original.listener.emit('closed',3000);assert.equal((await admin.call('/state')).data.channels[0].verified,1);
 live.listener.emit('closed',3000);ch=(await admin.call('/state')).data.channels[0];assert.equal(ch.verified,0);const count=mock.restored.length;await admin.call('/channels/'+ch.id+'/check','POST',{});assert.equal(mock.restored.length,count);
 const flow=await f.start(ch.id);const wrong=mock.complete(undefined,'999');await settle();assert.equal((await admin.call('/zalo-personal/flows/'+flow)).data.status,'failed');assert.ok(wrong.stopped);assert.equal((await admin.call('/state')).data.channels.length,1);
 await f.reopen();assert.ok(mock.restored.length>count);assert.ok(mock.restored.at(-1).cookie[0].value.includes('private-cookie'));const a=await f.client('admin@zalo.test');ch=(await a.call('/state')).data.channels[0];assert.equal(ch.verified,1);
 const start=(await a.call('/zalo-personal/start','POST',{channel_id:ch.id})).data;await settle();await a.call('/channels/'+ch.id,'DELETE',{confirm:true});const late=mock.complete();await settle();assert.equal((await a.call('/zalo-personal/flows/'+start.id)).data.status,'failed');assert.ok(late.stopped);assert.equal((await a.call('/state')).data.channels.length,0);
 mock.apis.at(-2).listener.emit('message',incoming('50'));assert.equal(f.app.db.prepare('SELECT COUNT(*) n FROM messages').get().n,0);
});

test('Expired and declined QR flows release pending authentication and cannot commit late results',async t=>{
 const f=await fixture(t,{zaloFlowMs:30});let id=await f.start();await new Promise(r=>setTimeout(r,60));assert.equal((await f.admin.call('/zalo-personal/flows/'+id)).data.status,'expired');assert.equal(f.mock.pending.at(-1).aborted,true);
 id=await f.start();const pending=f.mock.pending.at(-1);pending.callback({type:3,data:{code:'no'},actions:{abort:pending.abort}});await settle();assert.equal((await f.admin.call('/zalo-personal/flows/'+id)).data.status,'declined');assert.equal(pending.aborted,true);assert.equal(f.app.db.prepare('SELECT COUNT(*) n FROM channels').get().n,0);
});

test('A temporary socket interruption reconnects once; pausing during backoff cancels recovery',async t=>{
 const f=await fixture(t,{zaloRetryMs:25});await f.start();const first=f.mock.complete();await settle();const ch=(await f.admin.call('/state')).data.channels[0];
 first.listener.emit('closed',1006);first.listener.emit('closed',1006);
 await new Promise(r=>setTimeout(r,50));await settle();assert.equal(f.mock.restored.length,1);assert.equal((await f.admin.call('/state')).data.channels[0].verified,1);
 f.mock.apis.at(-1).listener.emit('closed',1006);await f.admin.call('/channels/'+ch.id,'PATCH',{enabled:false});await new Promise(r=>setTimeout(r,50));assert.equal(f.mock.restored.length,1);assert.equal((await f.admin.call('/state')).data.channels[0].enabled,0);
});

test('History preserves read/deletion markers; incoming files only use trusted Zalo CDNs',async t=>{
 const f=await fixture(t);await f.start();const api=f.mock.complete();await settle();api.listener.emit('message',incoming());await settle();const c=(await f.admin.call('/state')).data.conversations[0];await f.admin.call('/conversations/'+c.id+'/read','POST',{});
 const old=incoming('80');old.data.ts=Date.now()-100000;api.listener.emit('old_messages',[old],0);assert.equal(f.app.db.prepare('SELECT unread FROM conversations WHERE id=?').get(c.id).unread,0);
 let file=incoming('81');file.data.msgType='chat.photo';file.data.content={href:'https://s120-ava-talk.zadn.vn/photo.png',title:'Ảnh khách gửi'};api.listener.emit('message',file);await settle();assert.ok(f.app.db.prepare('SELECT attachment_id FROM messages WHERE external_id=?').get('81').attachment_id);
 const n=f.images.length;file=incoming('82');file.data.msgType='chat.photo';file.data.content={href:'http://127.0.0.1:9999/private',title:'forbidden'};api.listener.emit('message',file);await settle();assert.equal(f.app.db.prepare('SELECT attachment_id FROM messages WHERE external_id=?').get('82').attachment_id,null);assert.ok(f.images.slice(n).every(url=>url.startsWith('https://s120-ava-talk.zadn.vn/')));
 await f.admin.call('/conversations/'+c.id,'DELETE',{confirm:true});api.listener.emit('old_messages',[incoming('83')],0);assert.equal((await f.admin.call('/state')).data.conversations.length,0);
});

test('Zalo avatars use the real zadn.vn CDN, alternate profile keys, MIME sniffing and a short failure cache',async t=>{
 let failed=true;const f=await fixture(t,{fetchImage:async()=>failed?new Response('unavailable',{status:503}):new Response(png,{headers:{'content-type':'application/octet-stream'}})});await f.start();const api=f.mock.complete();await settle();
 api.getUserInfo=async id=>({changed_profiles:{[id+'_0']:{userId:id,displayName:'Tên khách',avatar:'http://s120-ava-talk.zadn.vn/real-avatar.jpg'}}});
 api.listener.emit('message',incoming());await settle();const c=(await f.admin.call('/state')).data.conversations[0],p=f.app.db.prepare('SELECT * FROM customer_profiles WHERE conversation_id=?').get(c.id);
 assert.equal(p.profile_status,'unavailable');assert.ok(p.retry_at<=Date.now()+60000);failed=false;
 f.app.db.prepare('UPDATE customer_profiles SET checked=0,retry_at=0 WHERE conversation_id=?').run(c.id);
 await f.admin.call('/conversations/'+c.id+'/profile-refresh','POST',{});let state=(await f.admin.call('/state')).data.conversations[0];assert.equal(state.has_avatar,1);assert.equal(state.profile_status,'ready');assert.equal(state.name,'Tên khách');assert.equal(f.app.db.prepare('SELECT avatar_type FROM customer_profiles WHERE conversation_id=?').get(c.id).avatar_type,'image/png');
 // Existing negative cache from 1.8.0 must not suppress the repair for a day.
 f.app.db.prepare("UPDATE customer_profiles SET avatar=NULL,retry_at=?,profile_status='unavailable' WHERE conversation_id=?").run(Date.now()+86400000,c.id);await f.reopen();assert.equal(f.app.db.prepare('SELECT retry_at FROM customer_profiles WHERE conversation_id=?').get(c.id).retry_at,0);
});

test('Native stickers sent by either party and replayed placeholders get cached as images, preserving emoji text',async t=>{
 const f=await fixture(t);await f.start();const api=f.mock.complete();await settle();
 let detailCalls=0;api.getStickersDetail=async id=>{detailCalls++;return [{id,stickerWebpUrl:'https://zalo-api.zadn.vn/sticker.webp',stickerUrl:'https://zalo-api.zadn.vn/sticker.png'}];};
 const sticker=incoming('90');sticker.data.msgType='chat.sticker';sticker.data.content={id:123,type:3,cateId:1};sticker.isSelf=true;api.listener.emit('message',sticker);await settle();
 let m=f.app.db.prepare('SELECT * FROM messages WHERE external_id=?').get('90');assert.equal(m.body,'[Sticker]');assert.ok(m.attachment_id);assert.equal(m.kind,'outgoing');assert.equal(detailCalls,1);assert.ok(!f.images.some(url=>url.startsWith('https://zalo-api.zadn.vn/')));const file=await f.admin.raw('/attachments/'+m.attachment_id);assert.equal(file.status,200);assert.deepEqual(Buffer.from(await file.arrayBuffer()),png);assert.ok(f.images.some(url=>url.startsWith('https://zalo-api.zadn.vn/')));
 // Simulate a placeholder already persisted by 1.8.0 and later returned in history.
 const ch=f.app.db.prepare('SELECT * FROM channels').get();f.app.ingest(ch,'222','Khách','91','[Nội dung đính kèm]');const replay={...sticker,isSelf:false,data:{...sticker.data,msgId:'91',content:JSON.stringify({sticker_id:123,params:'{}'})}};api.listener.emit('old_messages',[replay],0);await settle();m=f.app.db.prepare('SELECT * FROM messages WHERE external_id=?').get('91');assert.equal(m.body,'[Sticker]');assert.ok(m.attachment_id);
 api.listener.emit('message',incoming('92','222','❤️ 😂 👍'));assert.equal(f.app.db.prepare('SELECT body FROM messages WHERE external_id=?').get('92').body,'❤️ 😂 👍');
 const malicious=incoming('93');malicious.data.msgType='chat.sticker';malicious.data.content={href:'https://zalo-api.zadn.vn.evil.test/sticker.png'};const before=f.images.length;api.listener.emit('message',malicious);await settle();assert.equal(f.images.length,before);assert.equal(f.app.db.prepare('SELECT attachment_id FROM messages WHERE external_id=?').get('93').attachment_id,null);
 await f.admin.call('/conversations/'+m.conversation_id,'DELETE',{confirm:true});api.listener.emit('old_messages',[replay],0);await settle();assert.equal(f.app.db.prepare('SELECT COUNT(*) n FROM attachments').get().n,0);
});

test('Groups have separate identities, group photos/names and member authors; replies and files target the group',async t=>{
 const f=await fixture(t);await f.start();const api=f.mock.complete();await settle();const lookups=[];
 api.getGroupInfo=async id=>{lookups.push(id);return {gridInfoMap:{[id]:{groupId:id,name:'Nhóm tư vấn',avt:'https://s120-ava-talk.zadn.vn/group.png'}}};};
 const group=(id,sender,name,body)=>({...incoming(id,'222',body),type:1,data:{...incoming(id,'222',body).data,uidFrom:sender,dName:name}});
 api.listener.emit('message',incoming('100','222','Chat riêng'));api.listener.emit('message',group('100','444','Lan','Chào nhóm'));api.listener.emit('message',group('101','555','Minh','Xin tư vấn'));await settle();
 const state=(await f.admin.call('/state')).data;assert.equal(state.conversations.length,2);const g=state.conversations.find(c=>c.thread_type==='group'),u=state.conversations.find(c=>c.thread_type==='user');
 assert.equal(g.external_id,'group:222');assert.equal(u.external_id,'222');assert.equal(g.name,'Nhóm tư vấn');assert.equal(g.has_avatar,1);assert.equal(g.unread,2);assert.deepEqual(lookups,['222']);assert.ok(!g.profile_url);
 let messages=(await f.admin.call('/conversations/'+g.id+'/messages')).data;assert.deepEqual(messages.map(m=>m.author_name),['Lan','Minh']);assert.deepEqual(messages.map(m=>m.author_id),['444','555']);
 const sent=(await f.admin.call('/conversations/'+g.id+'/send','POST',{text:'Chào cả nhóm',request_id:'group-send'})).data;assert.equal(sent.status,'sent');assert.equal(api.sent.at(-1).type,1);assert.equal(api.sent.at(-1).threadId,'222');
 const file=(await f.admin.upload(g.id,'group.png')).data;assert.equal((await f.admin.call('/conversations/'+g.id+'/send','POST',{attachment_id:file.id,request_id:'group-file'})).data.status,'sent');assert.equal(api.sent.at(-1).type,1);
 await f.admin.call('/conversations/'+u.id+'/send','POST',{text:'Chat riêng',request_id:'direct-send'});assert.equal(api.sent.at(-1).type,0);assert.equal(api.sent.at(-1).threadId,'222');
 api.listener.emit('seen_messages',[{type:1,isSelf:false,threadId:'222',data:{msgId:sent.external_id,seenUids:['444']}}]);assert.equal(f.app.db.prepare('SELECT status FROM messages WHERE id=?').get(sent.id).status,'sent');
 // Historical copies of the same group message must not duplicate it or increase unread counts.
 const unread=f.app.db.prepare('SELECT unread FROM conversations WHERE id=?').get(g.id).unread;api.listener.emit('old_messages',[group('101','555','Minh','Xin tư vấn')],1);await settle();assert.equal(f.app.db.prepare('SELECT unread FROM conversations WHERE id=?').get(g.id).unread,unread);
 assert.equal(f.app.db.prepare('SELECT COUNT(*) n FROM messages WHERE conversation_id=? AND external_id=?').get(g.id,'101').n,1);
});

test('Group permissions, historical stickers, deletion and reopening retain normal shared inbox protections',async t=>{
 const f=await fixture(t);await f.start();const api=f.mock.complete();await settle();api.getGroupInfo=async id=>({gridInfoMap:{[id]:{name:'Nhóm kiểm thử',avt:'https://s120-ava-talk.zadn.vn/group.png'}}});
 const group={...incoming('110','888','Nhóm thử'),type:1,data:{...incoming('110','888','Nhóm thử').data,uidFrom:'444',dName:'Lan'}};api.listener.emit('message',group);await settle();let g=(await f.admin.call('/state')).data.conversations[0];
 const id=(await f.admin.call('/users','POST',{name:'Agent',email:'group-agent@zalo.test',password:'long-password-123',role:'agent'})).data.id;let a=await f.client('group-agent@zalo.test');assert.equal((await a.call('/state')).data.conversations.length,0);assert.equal((await a.call('/conversations/'+g.id+'/messages')).status,403);
 await f.admin.call('/users/'+id,'PATCH',{grants:[{channel_id:g.channel_id,can_reply:false}]});a=await f.client('group-agent@zalo.test');assert.equal((await a.call('/state')).data.conversations.length,1);assert.equal((await a.call('/conversations/'+g.id+'/send','POST',{text:'No',request_id:'forbidden'})).status,403);
 const sticker={...group,data:{...group.data,msgId:'111',msgType:'chat.sticker',content:{href:'https://zalo-api.zadn.vn/sticker.png'}}};api.listener.emit('old_messages',[sticker],1);await settle();assert.ok(f.app.db.prepare('SELECT attachment_id FROM messages WHERE conversation_id=? AND external_id=?').get(g.id,'111').attachment_id);assert.equal(f.app.db.prepare('SELECT unread FROM conversations WHERE id=?').get(g.id).unread,1);
 await f.admin.call('/conversations/'+g.id,'DELETE',{confirm:true});api.listener.emit('old_messages',[group,sticker],1);await settle();assert.equal((await f.admin.call('/state')).data.conversations.length,0);assert.equal(f.app.db.prepare('SELECT COUNT(*) n FROM attachments').get().n,0);
 const fresh={...group,data:{...group.data,msgId:'112',ts:Date.now()+10,content:'Tin nhóm mới'}};api.listener.emit('message',fresh);await settle();g=(await f.admin.call('/state')).data.conversations[0];assert.equal(g.thread_type,'group');assert.equal(g.unread,1);assert.equal(g.name,'Nhóm kiểm thử');
 await f.reopen();const admin=await f.client('admin@zalo.test');g=(await admin.call('/state')).data.conversations[0];assert.equal(g.thread_type,'group');assert.equal(g.external_id,'group:888');
 const before=f.mock.apis.at(-1).sent.length;await admin.call('/conversations/'+g.id+'/send','POST',{text:'Sau mở lại',request_id:'restored-group'});assert.equal(f.mock.apis.at(-1).sent.length,before+1);assert.equal(f.mock.apis.at(-1).sent.at(-1).type,1);
});

test('Restart fills the offline gap, marks missed arrivals unread once and protects recovery controls',async t=>{
 const f=await fixture(t,{zaloRecoveryOptions:{pageDelayMs:1}});await f.start();let api=f.mock.complete();await settle();api.listener.emit('message',incoming('150'));await settle();
 const c=(await f.admin.call('/state')).data.conversations[0];await f.admin.call('/conversations/'+c.id+'/read','POST',{});
 const before=Date.now()-86400000;
 await f.reopen(db=>db.prepare("UPDATE zalo_recovery SET last_online=?,status='reached'").run(before));api=f.mock.apis.at(-1);const missing=incoming('151');missing.data.ts=before+3600000;const anchor=incoming('149');anchor.data.ts=before-120001;
 api.listener.emit('old_messages',[missing,anchor],0);await settle();const admin=await f.client('admin@zalo.test');let state=(await admin.call('/state')).data;
 assert.equal(state.conversations[0].unread,1);assert.equal(state.channels[0].recovery[0].status,'reached');assert.ok((await admin.call('/conversations/'+c.id+'/messages')).data.some(m=>m.external_id==='151'));
 api.listener.emit('old_messages',[missing],0);await settle();assert.equal((await admin.call('/state')).data.conversations[0].unread,1);
 const id=(await admin.call('/users','POST',{name:'Viewer',email:'recovery-view@zalo.test',password:'long-password-123',role:'viewer'})).data.id;
 await admin.call('/users/'+id,'PATCH',{grants:[{channel_id:c.channel_id,can_reply:false}]});const viewer=await f.client('recovery-view@zalo.test');assert.equal((await viewer.call('/zalo-personal/channels/'+c.channel_id+'/sync','POST',{})).status,403);
 api.listener.emit('old_messages',[],1);await settle();assert.equal((await admin.call('/state')).data.channels[0].recovery[1].status,'limited');assert.equal((await admin.call('/zalo-personal/channels/'+c.channel_id+'/sync','POST',{})).status,200);
});
