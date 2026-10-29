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

import ExcelJS from 'exceljs';
import {dateRange} from './reporting.mjs';
import {workbookBuffer,productHeaders,readProductFile,parseCSV} from './spreadsheet-data.mjs';
import {presetRange,inRange} from './public/ui-kit.js';
test('Spreadsheet preview/import validates rows, is atomic, records stock, and retries idempotently',async t=>{
 const f=await fixture(t);
 const source=await workbookBuffer('San pham',productHeaders,[['EX-001','Áo, mới','Dòng một\nDòng hai',120000,4,'Đang bán'],['EX-002','Quần','',150000,0,'Ngừng bán']]);
 const preview=await f.admin.call('/products/import/preview','POST',{name:'catalog.xlsx',data:source.toString('base64')});
 assert.equal(preview.status,200,JSON.stringify(preview.data));assert.equal(preview.data.items.length,2);assert.equal(preview.data.errors.length,0);
 const body={rows:preview.data.items,request_id:'import-test-0001'};
 assert.equal((await f.admin.call('/products/import','POST',body)).status,200);
 assert.equal((await f.admin.call('/products/import','POST',body)).data.repeated,true);
 assert.equal((await f.admin.call('/products')).data.length,2);
 assert.equal(f.app.db.prepare('SELECT COUNT(*) n FROM stock_movements').get().n,1);
 const bad={request_id:'import-test-0002',rows:[{sku:'NEW-001',name:'New',price:1,stock:5,active:true},{sku:'EX-001',name:'Duplicate',price:1,stock:1,active:true}]};
 assert.equal((await f.admin.call('/products/import','POST',bad)).status,409);
 assert.equal((await f.admin.call('/products')).data.length,2);
 assert.equal((await f.admin.call('/products/import/preview','POST',{name:'p.csv',data:Buffer.from('Mã sản phẩm,Tên sản phẩm,Nội dung,Đơn giá,Tồn kho,Trạng thái\nX,A,,1,-2,Đang bán').toString('base64')})).data.errors.length,1);
 const id=(await f.admin.call('/users','POST',{name:'Staff',email:'export-staff@test.local',password:'inventory-test-password',role:'agent'})).data.id;
 const staff=await f.client('export-staff@test.local');
 assert.equal((await staff.call('/products/import','POST',body)).status,403);
 assert.equal((await f.guest.call('/products/import/preview','POST',{})).status,401);
});
test('Workbook import rejects formulas, oversized ZIP metadata, bad headers and malformed CSV',async()=>{
 const wb=new ExcelJS.Workbook(),s=wb.addWorksheet('Data');s.addRow(productHeaders);s.addRow(['A','Formula','',{formula:'1+2'},1,'Đang bán']);
 const bytes=Buffer.from(await wb.xlsx.writeBuffer());await assert.rejects(()=>readProductFile({name:'p.xlsx',data:bytes.toString('base64')}),/công thức/);
});
test('CSV quoting and workbook typed cells keep Unicode, multiline content and leading-zero codes',async()=>{
 assert.deepEqual(parseCSV('\uFEFFMã,Tên\n001,"A, B"\n002,"Nội dung\nxuống dòng"'),[['Mã','Tên'],['001','A, B'],['002','Nội dung\nxuống dòng']]);
 assert.throws(()=>parseCSV('a,b\n"x'),/ngoặc kép/);
 const b=await workbookBuffer('Sản phẩm',productHeaders,[['001','Tên tiếng Việt','nội dung',10,3,'Đang bán']]);
 const rows=await readProductFile({name:'p.xlsx',data:b.toString('base64')});assert.equal(rows[0].sku,'001');assert.equal(rows[0].price,10);
 const bad=Buffer.from(b),pos=bad.indexOf(Buffer.from('504b0102','hex'));bad.writeUInt32LE(20*1024**2,pos+24);
 await assert.rejects(()=>readProductFile({name:'bomb.xlsx',data:bad.toString('base64')}),/quá lớn/);
 await assert.rejects(()=>readProductFile({name:'p.csv',data:Buffer.from('a,b\n1,2').toString('base64')}),/Thiếu cột/);
});
test('Vietnamese date periods include both endpoints and reject invalid ranges',()=>{
 assert.deepEqual(presetRange('week',new Date('2026-10-28T20:00:00Z')),{preset:'week',from:'2026-10-26',to:'2026-10-29'});
 const r=dateRange(new URLSearchParams('from=2026-10-29&to=2026-10-29'));assert.equal(r.start,'2026-10-28T17:00:00.000Z');assert.equal(r.end,'2026-10-29T17:00:00.000Z');
 assert.equal(inRange('2026-10-28T17:00:00Z',r),true);assert.equal(inRange('2026-10-29T17:00:00Z',r),false);
 for(const text of ['from=2026-02-30&to=2026-03-01','from=2026-13-01&to=2026-13-02','from=2026-10-30&to=2026-10-01','from=2024-01-01&to=2026-01-01'])assert.throws(()=>dateRange(new URLSearchParams(text)));
});
test('Reports respect real channels, deleted records, date boundaries, order totals and channel grants',async t=>{
 const f=await fixture(t),db=f.app.db;
 // Use exactly one authorized live channel with synthetic local data.
 db.prepare("UPDATE channels SET mode='live' WHERE id=1").run();
 db.prepare('DELETE FROM messages').run();db.prepare('DELETE FROM conversations WHERE id<>1').run();db.prepare("UPDATE conversations SET status='pending',assignee=1 WHERE id=1").run();
 const add=(channel,external,created,kind='incoming',deleted=0)=>{db.prepare('INSERT INTO messages(conversation_id,external_id,kind,body,created,status,local_deleted) VALUES(?,?,?,?,?,?,?)').run(channel,external,kind,'Synthetic',created,'sent',deleted);};
 add(1,'before','2026-10-28T16:59:59Z');add(1,'inside','2026-10-28T17:00:00Z');add(1,'reply','2026-10-29T02:00:00Z','outgoing');add(1,'after','2026-10-29T17:00:00Z');add(1,'deleted','2026-10-29T02:00:00Z','incoming',1);
 const p=await f.create({stock:3});await f.order([{product_id:p.id,quantity:1}]);const o=(await f.orders())[0];
 await f.admin.call('/orders/'+o.id,'PATCH',{status:'completed',version:o.version});db.prepare("UPDATE orders SET created='2026-10-29T00:00:00Z'").run();
 const result=await f.admin.call('/reports?from=2026-10-29&to=2026-10-29');
 assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(result.data.counts.messages,2);assert.equal(result.data.counts.incoming,1);assert.equal(result.data.counts.outgoing,1);assert.equal(result.data.counts.pending,1);assert.equal(result.data.counts.completed,1);assert.equal(result.data.counts.completed_total,110000);
 const user=(await f.admin.call('/users','POST',{name:'Viewer',email:'empty-report@test.local',password:'inventory-test-password',role:'viewer'})).data;
 const other=await f.client('empty-report@test.local');const empty=await other.call('/reports?from=2026-10-29&to=2026-10-29');assert.equal(empty.data.counts.messages,0);assert.equal(empty.data.counts.orders,0);
 assert.equal((await f.admin.call('/reports?from=2026-13-01&to=2026-13-02')).status,400);
});
test('Order/product exports apply permissions and filters, preserve values, neutralize CSV formulas',async t=>{
 const f=await fixture(t),p=await f.create({name:'=HYPERLINK("x")',sku:'001',stock:4});
 await f.order([{product_id:p.id,quantity:1}]);f.app.db.prepare("UPDATE orders SET created='2026-10-29T01:00:00Z',customer='=cmd'").run();
 const login=await fetch(f.base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'inventory@test.local',password:'inventory-test-password'})}),cookie=login.headers.get('set-cookie').split(';')[0];
 const me=await (await fetch(f.base+'/api/me',{headers:{Cookie:cookie}})).json(),headers={Cookie:cookie,'X-CSRF-Token':me.csrf,'Content-Type':'application/json'};
 const r=await fetch(f.base+'/api/orders/export?from=2026-10-29&to=2026-10-29&status=new',{headers});assert.equal(r.status,200);
 const wb=new ExcelJS.Workbook();await wb.xlsx.load(Buffer.from(await r.arrayBuffer()));assert.equal(wb.worksheets[0].rowCount,2);assert.equal(wb.worksheets[0].getCell('C2').value,'=cmd');assert.equal(wb.worksheets[0].getCell('I2').value,110000);
 const csv=await (await fetch(f.base+'/api/orders/export?from=2026-10-29&to=2026-10-29&format=csv',{headers})).text();assert.ok(csv.includes("'=cmd"));
 const empty=await fetch(f.base+'/api/orders/export?from=2026-10-29&to=2026-10-29&status=completed',{headers});const e=new ExcelJS.Workbook();await e.xlsx.load(Buffer.from(await empty.arrayBuffer()));assert.equal(e.worksheets[0].rowCount,1);
 const prod=await fetch(f.base+'/api/products/export',{method:'POST',headers,body:JSON.stringify({ids:[p.id],format:'xlsx'})});assert.equal(prod.status,200);const pw=new ExcelJS.Workbook();await pw.xlsx.load(Buffer.from(await prod.arrayBuffer()));assert.equal(pw.worksheets[0].getCell('A2').value,'001');assert.equal(pw.worksheets[0].getCell('B2').type,ExcelJS.ValueType.String);
});
