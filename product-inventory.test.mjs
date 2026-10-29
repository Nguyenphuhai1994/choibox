import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from './server.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==','base64');
async function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'choibox-stock-')),apps=[];
 async function start(){const app=createApp({dataDir:dir});apps.push(app);await new Promise(r=>app.server.listen(0,'127.0.0.1',r));return {app,base:'http://127.0.0.1:'+app.server.address().port};}
 const {app,base}=await start();
 t.after(async()=>{for(const a of apps){if(a.server.listening){await new Promise(r=>a.server.close(r));a.db.close();}}rmSync(dir,{recursive:true,force:true});});
 async function client(email,origin=base){let cookie='',csrf='';async function call(p,method='GET',body){const r=await fetch(origin+'/api'+p,{method,headers:{Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':csrf},...(body===undefined?{}:{body:JSON.stringify(body)})});const s=r.headers.get('set-cookie');if(s)cookie=s.split(';')[0];return {status:r.status,data:await r.json()};}
  if(email){assert.equal((await call('/login','POST',{email,password:'inventory-test-password'})).status,200);csrf=(await call('/me')).data.csrf;}
  return {call,image:(id)=>fetch(origin+'/api/products/'+id+'/image',{headers:{Cookie:cookie}})};
 }
 const guest=await client();await guest.call('/setup','POST',{name:'Inventory test',email:'inventory@test.local',password:'inventory-test-password'});
 const admin=await client('inventory@test.local');await admin.call('/demo','POST',{});
 const create=async(overrides={})=>{const r=await admin.call('/products','POST',{name:'Áo thử',sku:'AO-'+Math.random().toString(16).slice(2,10),description:'Nội dung thử',price:100000,stock:5,...overrides});assert.equal(r.status,201,JSON.stringify(r.data));return r.data;};
 const product=async id=>(await admin.call('/products')).data.find(p=>p.id===id);
 const order=(items,request_id='request-'+Math.random())=>admin.call('/conversations/1/orders','POST',{customer:'Khách thử',items,request_id,shipping:10000,discount:0});
 const orders=async()=>(await admin.call('/state')).data.orders;
 return {app,base,admin,guest,client,create,product,order,orders,start,dir};
}
test('Catalog permissions, image content checks, SKU uniqueness and manual inventory validation',async t=>{
 const f=await fixture(t);
 const p=await f.create({sku:'AO-001',image:{mime:'image/png',data:png.toString('base64')}});
 assert.equal(p.has_image,true);assert.ok(!('image' in p));
 assert.equal((await f.guest.call('/products')).status,401);assert.equal((await f.guest.image(p.id)).status,401);
 const image=await f.admin.image(p.id);assert.equal(image.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await image.arrayBuffer()),png);
 const id=(await f.admin.call('/users','POST',{name:'Staff',email:'stock-staff@test.local',password:'inventory-test-password',role:'agent'})).data.id;
 const staff=await f.client('stock-staff@test.local');
 assert.equal((await staff.call('/products')).status,200);assert.equal((await staff.call('/products','POST',{name:'X',stock:2,price:1})).status,403);
 assert.equal((await staff.call('/products/'+p.id,'PATCH',{stock:999,version:p.version})).status,403);
 assert.equal((await f.admin.call('/products','POST',{name:'X',sku:'ao-001',price:2,stock:1})).status,409);
 for(const stock of [-1,1.2,1e12])assert.equal((await f.admin.call('/products/'+p.id,'PATCH',{stock,version:p.version})).status,400);
 const bad=await f.admin.call('/products/'+p.id,'PATCH',{stock:20,version:p.version,image:{mime:'image/png',data:Buffer.from('<svg/>').toString('base64')}});assert.equal(bad.status,400);assert.equal((await f.product(p.id)).stock,5);
 const updated=await f.admin.call('/products/'+p.id,'PATCH',{stock:8,version:p.version,image:null});assert.equal(updated.status,200);assert.equal(updated.data.has_image,false);
 assert.equal((await f.admin.image(p.id)).status,404);
 assert.equal((await f.admin.call('/products/'+p.id,'PATCH',{stock:99,version:p.version})).status,409);
});
test('Orders require catalog products, charge catalog prices and cannot buy inactive or exhausted stock',async t=>{
 const f=await fixture(t),p=await f.create({stock:2,price:125000});
 assert.equal((await f.order([{name:'Manual bypass',quantity:1,price:0}])).status,400);
 assert.equal((await f.order([{product_id:p.id,quantity:1,price:1}])).status,409);
 assert.equal((await f.order([{product_id:p.id,quantity:3}])).status,409);
 const r=await f.order([{product_id:p.id,name:'Tampered name',quantity:2}], 'authoritative-price');assert.equal(r.status,201);
 assert.equal((await f.product(p.id)).stock,0);
 const o=(await f.orders())[0];assert.equal(o.total,260000);assert.equal(o.items[0].name,'Áo thử');assert.equal(o.items[0].price,125000);assert.equal(o.inventory_state,'reserved');
 assert.equal((await f.order([{product_id:p.id,quantity:1}])).status,409);
});
test('Multi-product order rolls back all stock, order rows and internal chat cards when one item is unavailable',async t=>{
 const f=await fixture(t),p=await f.create({stock:3}),q=await f.create({stock:0});
 const before=f.app.db.prepare('SELECT COUNT(*) n FROM messages').get().n;
 assert.equal((await f.order([{product_id:p.id,quantity:2},{product_id:q.id,quantity:1}])).status,409);
 assert.equal((await f.product(p.id)).stock,3);assert.equal((await f.orders()).length,0);
 assert.equal(f.app.db.prepare('SELECT COUNT(*) n FROM stock_movements WHERE order_id IS NOT NULL').get().n,0);
 assert.equal(f.app.db.prepare('SELECT COUNT(*) n FROM messages').get().n,before);
});
test('Concurrent orders through two server connections cannot oversell; repeated product rows are aggregated',async t=>{
 const f=await fixture(t),p=await f.create({stock:1}),second=await f.start(),other=await f.client('inventory@test.local',second.base);
 const body={customer:'Khách thử',items:[{product_id:p.id,quantity:1}],shipping:0,discount:0};
 const results=await Promise.all([f.admin.call('/conversations/1/orders','POST',{...body,request_id:'worker-a'}),other.call('/conversations/1/orders','POST',{...body,request_id:'worker-b'})]);
 assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);assert.equal((await f.product(p.id)).stock,0);assert.equal((await f.orders()).length,1);
 const q=await f.create({stock:3});
 assert.equal((await f.order([{product_id:q.id,quantity:2},{product_id:q.id,quantity:2}])).status,409);assert.equal((await f.product(q.id)).stock,3);
 assert.equal((await f.order([{product_id:q.id,quantity:1},{product_id:q.id,quantity:2}])).status,201);
 const o=(await f.orders()).find(o=>o.items.some(i=>i.product_id===q.id));assert.equal(o.items.length,1);assert.equal(o.items[0].quantity,3);
});
test('Retry is idempotent and cancellation returns stock exactly once, even for archived products',async t=>{
 const f=await fixture(t),p=await f.create({stock:5}),items=[{product_id:p.id,quantity:2}];
 const results=await Promise.all([f.order(items,'same-request'),f.order(items,'same-request')]);assert.deepEqual(results.map(r=>r.status).sort(),[200,201]);
 assert.equal((await f.product(p.id)).stock,3);assert.equal((await f.orders()).length,1);
 let current=await f.product(p.id);await f.admin.call('/products/'+p.id,'PATCH',{active:false,version:current.version});
 let o=(await f.orders())[0];assert.equal((await f.admin.call('/orders/'+o.id,'PATCH',{status:'cancelled',version:o.version})).status,200);
 assert.equal((await f.product(p.id)).stock,5);
 assert.equal((await f.admin.call('/orders/'+o.id,'PATCH',{status:'cancelled',version:o.version})).status,409);
 o=(await f.orders())[0];assert.equal(o.inventory_state,'released');
 assert.equal((await f.admin.call('/orders/'+o.id,'PATCH',{status:'cancelled',version:o.version})).status,200);assert.equal((await f.product(p.id)).stock,5);
 assert.equal((await f.admin.call('/orders/'+o.id,'PATCH',{status:'confirmed',version:o.version})).status,409);
});
test('Reopening cancelled orders rechecks stock; a failed reopen preserves cancelled status and balances',async t=>{
 const f=await fixture(t),p=await f.create({stock:2});await f.order([{product_id:p.id,quantity:2}]);
 let o=(await f.orders())[0];await f.admin.call('/orders/'+o.id,'PATCH',{status:'cancelled',version:o.version});
 let current=await f.product(p.id);await f.admin.call('/products/'+p.id,'PATCH',{stock:1,version:current.version});
 o=(await f.orders())[0];assert.equal((await f.admin.call('/orders/'+o.id,'PATCH',{status:'new',version:o.version})).status,409);
 assert.equal((await f.product(p.id)).stock,1);assert.equal((await f.orders())[0].status,'cancelled');
 current=await f.product(p.id);await f.admin.call('/products/'+p.id,'PATCH',{stock:3,version:current.version});
 assert.equal((await f.admin.call('/orders/'+o.id,'PATCH',{status:'confirmed',version:o.version})).status,200);assert.equal((await f.product(p.id)).stock,1);
 o=(await f.orders())[0];await f.admin.call('/orders/'+o.id,'PATCH',{status:'completed',version:o.version});assert.equal((await f.product(p.id)).stock,1);
});
test('Stock edits detect sales after opening the editor and history keeps the purchased product snapshot',async t=>{
 const f=await fixture(t),p=await f.create({stock:5,price:60000});await f.order([{product_id:p.id,quantity:1}]);
 assert.equal((await f.admin.call('/products/'+p.id,'PATCH',{stock:20,version:p.version})).status,409);assert.equal((await f.product(p.id)).stock,4);
 const current=await f.product(p.id);await f.admin.call('/products/'+p.id,'PATCH',{name:'Tên mới',price:90000,description:'Mới',version:current.version});
 const o=(await f.orders())[0];assert.equal(o.items[0].name,p.name);assert.equal(o.items[0].price,60000);
 assert.equal((await f.order([{product_id:p.id,quantity:1,price:60000}])).status,409);
});
test('Order permissions still require the conversation grant, while legacy orders never change catalog stock',async t=>{
 const f=await fixture(t),p=await f.create();
 const id=(await f.admin.call('/users','POST',{name:'Staff',email:'stock-agent@test.local',password:'inventory-test-password',role:'agent'})).data.id;
 const staff=await f.client('stock-agent@test.local');const body={customer:'Khách',items:[{product_id:p.id,quantity:1}],request_id:'staff-grant'};
 assert.equal((await staff.call('/conversations/1/orders','POST',body)).status,403);
 await f.admin.call('/users/'+id,'PATCH',{grants:[{channel_id:1,can_reply:true}]});
 const refreshed=await f.client('stock-agent@test.local');assert.equal((await refreshed.call('/conversations/1/orders','POST',body)).status,201);
 const time=new Date().toISOString();const old=Number(f.app.db.prepare("INSERT INTO orders(conversation_id,request_id,customer,items,shipping,discount,total,created,updated) VALUES(1,'legacy','Khách cũ',?,0,0,1,?,?)").run(JSON.stringify([{name:'Hàng cũ',quantity:3,price:1}]),time,time).lastInsertRowid);
 assert.equal((await f.admin.call('/orders/'+old,'PATCH',{status:'cancelled',version:1})).status,200);assert.equal((await f.product(p.id)).stock,4);
 assert.equal((await f.admin.call('/orders/'+old,'PATCH',{status:'new',version:2})).status,200);assert.equal((await f.product(p.id)).stock,4);
});

test('Product images persist outside temporary-media cleanup and legacy order schemas migrate without reserving stock',async t=>{
 const f=await fixture(t),p=await f.create({image:{mime:'image/png',data:png.toString('base64')},stock:5});
 const time=new Date().toISOString();
 const id=Number(f.app.db.prepare("INSERT INTO orders(conversation_id,request_id,customer,items,shipping,discount,total,created,updated) VALUES(1,'pre-inventory','Đơn cũ',?,0,0,1,?,?)").run(JSON.stringify([{name:'Hàng cũ',quantity:1,price:1}]),time,time).lastInsertRowid);
 await new Promise(r=>f.app.server.close(r));f.app.db.exec('ALTER TABLE orders DROP COLUMN inventory_state');f.app.db.close();
 const next=await f.start(),admin=await f.client('inventory@test.local',next.base);
 assert.equal((await admin.call('/state')).data.orders.find(o=>o.id===id).inventory_state,'legacy');
 assert.equal((await admin.call('/orders/'+id,'PATCH',{status:'cancelled',version:1})).status,200);
 assert.equal((await admin.call('/products')).data.find(x=>x.id===p.id).stock,5);
 await admin.call('/storage/cleanup','POST',{confirm:true});
 const image=await admin.image(p.id);assert.equal(image.status,200);assert.deepEqual(Buffer.from(await image.arrayBuffer()),png);
});
