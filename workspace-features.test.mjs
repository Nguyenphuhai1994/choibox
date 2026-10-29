import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from './server.mjs';
import {profileLink} from './workspace-features.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==','base64');
test('Profile links only accept real platform HTTPS URLs',()=>{for(const s of ['javascript:alert(1)','https://facebook.com.evil.test/a','https://www.facebook.com/a?access_token=secret','https://me:secret@www.facebook.com/a'])assert.equal(profileLink(s,'facebook'),'');assert.equal(profileLink('https://www.facebook.com/example','facebook'),'https://www.facebook.com/example');});
test('Attachments, customer profiles, colored tags and orders retain channel permissions and persistence',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'choibox-features-')),calls=[],imageCalls=[];let badSend=false;
 const transport=async(url,options)=>{calls.push({url,options});const u=new URL(url);
  if(u.pathname.endsWith('/222'))return {id:'222',first_name:'Minh',last_name:'Anh',profile_pic:'https://test.fbcdn.net/avatar.png'};
  if(u.pathname.endsWith('/conversations'))return {data:[]};
  if(u.pathname.includes('/upload/'))return {error:0,data:{attachment_id:'image-token',token:'file-token'}};
  if(badSend)throw Error('private-token');
  if(u.hostname==='openapi.zalo.me')return {error:0,data:{message_id:'zalo-'+calls.length}};
  return {message_id:'facebook-'+calls.length};
 };
 let app=createApp({dataDir:dir,transport,fetchImage:async url=>{imageCalls.push(url);return new Response(png,{headers:{'Content-Type':'image/png'}});}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));let base='http://127.0.0.1:'+app.server.address().port;
 t.after(async()=>{await new Promise(r=>app.server.close(r));app.db.close();rmSync(dir,{recursive:true,force:true});});
 async function client(email,password='long-password-123'){let cookie='',csrf='';const call=async(p,method='GET',data)=>{const r=await fetch(base+'/api'+p,{method,headers:{cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json'},...(data===undefined?{}:{body:JSON.stringify(data)})});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return {status:r.status,data:await r.json()};};if(email){await call('/login','POST',{email,password});csrf=(await call('/me')).data.csrf;}return {call,upload:async(id,name,data=png)=>{const r=await fetch(base+'/api/conversations/'+id+'/attachments',{method:'POST',headers:{cookie,'X-CSRF-Token':csrf,'X-File-Name':encodeURIComponent(name),'Content-Type':'application/octet-stream'},body:data});return {status:r.status,data:await r.json()};},file:(id,range)=>fetch(base+'/api/attachments/'+id,{headers:{cookie,...(range?{Range:range}:{})}}),avatar:id=>fetch(base+'/api/conversations/'+id+'/avatar',{headers:{cookie}})};}
 const staticModule=await fetch(base+'/message-layout.js');assert.equal(staticModule.status,200);assert.match(staticModule.headers.get('content-type'),/javascript/);
 const guest=await client();await guest.call('/setup','POST',{name:'Admin',email:'features@test.local',password:'long-password-123'});const admin=await client('features@test.local');
 await admin.call('/channels','POST',{provider:'facebook',name:'Test Page',external_id:'111',access_token:'private-token',app_secret:'secret',verify_token:'verify'});
 await admin.call('/channels','POST',{provider:'zalo',name:'Test OA',external_id:'333',access_token:'zalo-private-token',app_secret:'secret',app_id:'444'});
 app.db.prepare('UPDATE channels SET verified=1').run();for(const ch of app.db.prepare('SELECT * FROM channels').all())app.ingest(ch,'222','222','m'+ch.id,'Test');
 const viewerId=(await admin.call('/users','POST',{name:'Viewer',email:'viewer@test.local',password:'long-password-123',role:'viewer'})).data.id;
 await admin.call('/users/'+viewerId,'PATCH',{grants:[{channel_id:1,can_reply:true}]});const viewer=await client('viewer@test.local');
 await t.test('Private upload and download, format and CSRF protections',async()=>{
  assert.equal((await guest.upload(1,'test.png')).status,401);assert.equal((await viewer.upload(1,'test.png')).status,403);
  assert.equal((await admin.upload(1,'test.html',Buffer.from('<script>alert(1)</script>'))).status,400);assert.equal((await admin.upload(1,'test.png',Buffer.from('not a png'))).status,400);
  const a=await admin.upload(1,'ảnh khách.png');assert.equal(a.status,201);assert.equal((await guest.file(a.data.id)).status,401);assert.equal((await viewer.file(a.data.id)).status,200);const file=await admin.file(a.data.id);assert.equal(file.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await file.arrayBuffer()),png);
  const partial=await admin.file(a.data.id,'bytes=0-7');assert.equal(partial.status,206);assert.equal(partial.headers.get('content-range'),`bytes 0-7/${png.length}`);assert.deepEqual(Buffer.from(await partial.arrayBuffer()),png.subarray(0,8));
  const tail=await admin.file(a.data.id,'bytes=-5');assert.equal(tail.status,206);assert.deepEqual(Buffer.from(await tail.arrayBuffer()),png.subarray(-5));
  for(const range of ['bytes=999999-','bytes=8-2','bytes=-0','bytes=0-1,4-5']){const r=await admin.file(a.data.id,range);assert.equal(r.status,416);assert.equal(r.headers.get('content-range'),`bytes */${png.length}`);}
  assert.equal((await guest.file(a.data.id,'bytes=0-7')).status,401);
  const other=await admin.upload(2,'test.png');assert.equal((await viewer.file(other.data.id)).status,403);assert.equal((await viewer.file(other.data.id,'bytes=0-7')).status,403);
 });
 await t.test('Facebook file send uses multipart and deduplicates repeated requests',async()=>{
  const a=(await admin.upload(1,'test.png')).data;const before=calls.length;const body={attachment_id:a.id,request_id:'same-send'};const m=(await admin.call('/conversations/1/send','POST',body)).data;assert.equal(m.status,'sent');const call=calls.at(-1);assert.ok(call.options.body instanceof FormData);assert.equal(JSON.parse(call.options.body.get('message')).attachment.type,'image');assert.equal(call.options.body.get('filedata').size,png.length);assert.equal(call.options.headers['Content-Type'],undefined);
  assert.equal((await admin.call('/conversations/1/send','POST',body)).data.id,m.id);assert.equal(calls.length,before+1);
  assert.equal((await admin.call('/conversations/2/send','POST',{attachment_id:a.id,request_id:'wrong-channel'})).status,400);
  assert.equal((await admin.call('/conversations/1/send','POST',{attachment_id:a.id,request_id:'duplicate-file'})).status,400);
  const ms=(await admin.call('/conversations/1/messages')).data;assert.equal(ms.find(x=>x.id===m.id).attachment.name,'test.png');
  await admin.call('/messages/'+m.id+'/moderate','POST',{action:'local-delete',confirm:true});assert.equal((await admin.file(a.id)).status,404);
  for(const [name,mime,type] of [['video.mp4','video/mp4','video'],['report.pdf','application/pdf','file']]){const a=(await admin.upload(1,name,Buffer.from('test-provider-payload'))).data;const sent=await admin.call('/conversations/1/send','POST',{attachment_id:a.id,request_id:name});assert.equal(sent.data.status,'sent');const form=calls.at(-1).options.body;assert.equal(JSON.parse(form.get('message')).attachment.type,type);assert.equal(form.get('filedata').type,mime);}
 });
 await t.test('Zalo image and document uploads use provider payloads',async()=>{
  for(const [name,data] of [['image.png',png],['invoice.pdf',Buffer.from('%PDF-test')]]){const a=(await admin.upload(2,name,data)).data;const r=await admin.call('/conversations/2/send','POST',{attachment_id:a.id,request_id:name});assert.equal(r.data.status,'sent');const payload=JSON.parse(calls.at(-1).options.body);assert.equal(payload.recipient.user_id,'222');assert.equal(payload.message.attachment.type,name.endsWith('png')?'template':'file');}
  assert.equal((await admin.upload(2,'too-big.png',Buffer.concat([png,Buffer.alloc(1024*1024)]))).status,400);
  assert.equal((await admin.upload(2,'video.mp4',Buffer.from('test'))).status,400);
  assert.equal((await admin.upload(2,'big.pdf',Buffer.alloc(5*1024*1024+1))).status,400);
 });
 await t.test('Failed sends remain failures and never expose credentials',async()=>{const a=(await admin.upload(1,'report.pdf',Buffer.from('%PDF-'))).data;badSend=true;const r=await admin.call('/conversations/1/send','POST',{attachment_id:a.id,request_id:'failed'});badSend=false;assert.equal(r.data.status,'failed');assert.ok(!JSON.stringify(r).includes('private-token'));});
 await t.test('Avatar enrichment caches images, profile links validate and tags use saved colors',async()=>{
  const r=await admin.avatar(1);assert.equal(r.status,200);assert.equal(imageCalls.length,1);await admin.avatar(1);assert.equal(imageCalls.length,1);
  assert.equal((await viewer.call('/conversations/1/profile','PATCH',{})).status,403);assert.equal((await admin.call('/conversations/1/profile','PATCH',{profile_url:'javascript:alert(1)'})).status,400);
  await admin.call('/conversations/1/profile','PATCH',{profile_url:'https://www.facebook.com/example',phone:'0900000000',address:'Hà Nội'});
  assert.equal((await viewer.call('/tags','POST',{name:'VIP',color:'#123456'})).status,403);assert.equal((await admin.call('/tags','POST',{name:'VIP',color:'red; background:url(evil)'})).status,400);
  const c=(await admin.call('/state')).data.conversations.find(c=>c.id===1);await admin.call('/conversations/1','PATCH',{version:c.version,tags:['VIP']});await admin.call('/tags','POST',{name:'VIP',color:'#2563a6'});const state=(await admin.call('/state')).data;assert.equal(state.tag_colors[0].color,'#2563a6');assert.equal(state.conversations.find(c=>c.id===1).profile_url,'https://www.facebook.com/example');assert.ok(!JSON.stringify(state).includes('private-token'));assert.ok(!JSON.stringify(state).includes('iVBOR'));
 });
 await t.test('Orders compute totals on server, are idempotent and use versioned status updates',async()=>{
  const product=(await admin.call('/products','POST',{name:'Áo',sku:'AO-ORDER',price:250000,stock:5})).data;
  const body={request_id:'order-1',customer:'Minh Anh',phone:'0900000000',address:'Hà Nội',items:[{product_id:product.id,quantity:2,price:250000}],shipping:30000,discount:10000,total:1};
  assert.equal((await viewer.call('/conversations/1/orders','POST',body)).status,403);assert.equal((await admin.call('/conversations/1/orders','POST',{...body,items:[{name:'X',quantity:-1,price:1}]})).status,400);
  const r=await admin.call('/conversations/1/orders','POST',body);assert.equal(r.status,201);assert.equal((await admin.call('/conversations/1/orders','POST',body)).data.id,r.data.id);let o=(await admin.call('/state')).data.orders[0];assert.equal(o.total,520000);
  assert.equal((await viewer.call('/orders/'+o.id,'PATCH',{status:'confirmed',version:o.version})).status,403);assert.equal((await admin.call('/orders/'+o.id,'PATCH',{status:'confirmed',version:o.version})).status,200);assert.equal((await admin.call('/orders/'+o.id,'PATCH',{status:'shipping',version:o.version})).status,409);
  assert.equal((await admin.call('/conversations/1/messages')).data.filter(m=>m.kind==='order').length,1);assert.equal(calls.filter(c=>c.options.body instanceof FormData&&c.options.body.has('recipient')).length,4);
 });
 await t.test('Database reopens with orders, attachments and colors preserved',async()=>{await new Promise(r=>app.server.close(r));app.db.close();app=createApp({dataDir:dir,transport});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+app.server.address().port;const a=await client('features@test.local');const d=(await a.call('/state')).data;assert.equal(d.orders.length,1);assert.equal(d.orders[0].status,'confirmed');assert.equal(d.tag_colors[0].name,'VIP');assert.ok(app.db.prepare('SELECT COUNT(*) n FROM attachments').get().n>0);});
});
