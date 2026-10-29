import {readProductFile} from './spreadsheet-data.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {imageSize} from 'image-size';
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
const money=n=>Number.isSafeInteger(n)&&n>=0&&n<=100000000000;
const timestamp=()=>new Date().toISOString();
export function productInventory({db,audit}){
 const get=(s,...p)=>db.prepare(s).get(...p),all=(s,...p)=>db.prepare(s).all(...p),run=(s,...p)=>db.prepare(s).run(...p);
 db.exec(`CREATE TABLE IF NOT EXISTS products(
 id INTEGER PRIMARY KEY,sku TEXT NOT NULL COLLATE NOCASE UNIQUE,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',
 price INTEGER NOT NULL CHECK(price>=0),stock INTEGER NOT NULL CHECK(stock>=0),active INTEGER NOT NULL DEFAULT 1,
 version INTEGER NOT NULL DEFAULT 1,image BLOB,image_type TEXT,image_version INTEGER NOT NULL DEFAULT 0,created TEXT NOT NULL,updated TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS product_imports(request_id TEXT PRIMARY KEY,digest TEXT NOT NULL,count INTEGER NOT NULL,created TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS stock_movements(id INTEGER PRIMARY KEY,product_id INTEGER NOT NULL REFERENCES products(id),
 delta INTEGER NOT NULL,balance INTEGER NOT NULL,reason TEXT NOT NULL,order_id INTEGER REFERENCES orders(id),user_id INTEGER REFERENCES users(id),created TEXT NOT NULL);
 `);
 if(!all('PRAGMA table_info(orders)').some(c=>c.name==='inventory_state'))db.exec("ALTER TABLE orders ADD COLUMN inventory_state TEXT NOT NULL DEFAULT 'legacy'");
 const publicProduct=p=>{const {image,image_type,...rest}=p;return {...rest,has_image:!!(p.has_image??image?.length)};};
 const columns='id,sku,name,description,price,stock,active,version,image_version,created,updated,length(image)>0 has_image';
 const state=()=>all('SELECT '+columns+' FROM products ORDER BY active DESC,id DESC').map(publicProduct);
 function atomic(fn){db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}
 function movement(p,delta,reason,u,orderId=null){
  if(!Number.isSafeInteger(p.stock+delta)||p.stock+delta<0)fail(409,'Số lượng tồn kho không hợp lệ.');
  run('UPDATE products SET stock=stock+?,version=version+1,updated=? WHERE id=?',delta,timestamp(),p.id);
  run('INSERT INTO stock_movements(product_id,delta,balance,reason,order_id,user_id,created) VALUES(?,?,?,?,?,?,?)',p.id,delta,p.stock+delta,reason,orderId,u.id,timestamp());
 }
 function imageValue(v){
  if(v===null)return {data:null,mime:null};
  if(!v||!['image/jpeg','image/png','image/webp'].includes(v.mime)||typeof v.data!=='string'||v.data.length>700000||!v.data.length||!/^[A-Za-z0-9+/]+={0,2}$/.test(v.data))fail(400,'Ảnh sản phẩm cần là JPG, PNG hoặc WebP, tối đa 512 KB sau tối ưu.');
  const data=Buffer.from(v.data,'base64');
  const mime=data.subarray(0,3).toString('hex')==='ffd8ff'?'image/jpeg':data.subarray(0,8).toString('hex')==='89504e470d0a1a0a'?'image/png':data.subarray(0,4).toString()==='RIFF'&&data.subarray(8,12).toString()==='WEBP'?'image/webp':'';
  if(!data.length||data.length>512*1024||mime!==v.mime)fail(400,'Nội dung ảnh sản phẩm không đúng định dạng.');
  try{const d=imageSize(data);if(!d.width||!d.height||d.width>10000||d.height>10000||d.width*d.height>25000000)throw Error();}catch{fail(400,'Ảnh sản phẩm không đọc được hoặc kích thước quá lớn.');}
  return {data,mime};
 }
 function normalize(body,p={}){
  const value=(k,d)=>body[k]===undefined?(p[k]??d):body[k];
  const name=value('name',''),description=value('description',''),sku=value('sku','')||'SP'+randomUUID().replaceAll('-','').slice(0,10).toUpperCase(),price=value('price',0),stock=value('stock',0),active=value('active',true);
  if(typeof name!=='string'||!name.trim()||name.trim().length>200||typeof description!=='string'||description.length>6000)fail(400,'Nhập tên sản phẩm (tối đa 200 ký tự) và nội dung tối đa 6.000 ký tự.');
  if(typeof sku!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/.test(sku))fail(400,'Mã sản phẩm chỉ gồm chữ, số, dấu chấm, gạch ngang hoặc gạch dưới.');
  if(!money(price)||!Number.isSafeInteger(stock)||stock<0||stock>1000000000||![true,false,0,1].includes(active))fail(400,'Đơn giá hoặc tồn kho không hợp lệ. Tồn kho phải là số nguyên không âm.');
  return {name:name.trim(),description:description.trim(),sku:sku.toUpperCase(),price,stock,active:active?1:0};
 }
 // All reservation/release calls run inside the caller's order transaction.
 function orderItems(input){
  if(!Array.isArray(input)||!input.length||input.length>30)fail(400,'Chọn ít nhất một sản phẩm trong danh mục (tối đa 30 dòng).');
  const grouped=new Map();
  for(const i of input){
   if(!i||!Number.isSafeInteger(i.product_id)||i.product_id<1||!Number.isInteger(i.quantity)||i.quantity<1||i.quantity>10000)fail(400,'Chọn sản phẩm trong danh mục và số lượng từ 1 đến 10.000.');
   const p=get('SELECT id,sku,name,price,stock,active FROM products WHERE id=?',i.product_id);
   if(!p||!p.active)fail(409,'Sản phẩm không còn được bán. Vui lòng chọn lại.');
   if(i.price!==undefined&&i.price!==p.price)fail(409,'Đơn giá '+p.name+' đã thay đổi. Kiểm tra lại trước khi tạo đơn.');
   const old=grouped.get(p.id);const quantity=(old?.quantity||0)+i.quantity;
   if(quantity>10000)fail(400,'Mỗi sản phẩm tối đa 10.000 đơn vị trong một đơn.');
   grouped.set(p.id,{product_id:p.id,sku:p.sku,name:p.name,quantity,price:p.price});
  }
  return [...grouped.values()];
 }
 function reserve(items,u,orderId){
  for(const i of items){
   const p=get('SELECT id,sku,name,price,stock,active FROM products WHERE id=?',i.product_id);
   if(!p||!p.active)fail(409,'Sản phẩm '+i.name+' đã ngừng bán.');
   if(p.stock<i.quantity)fail(409,'Không đủ tồn kho: '+p.name+' (còn '+p.stock+', cần '+i.quantity+').');
   movement(p,-i.quantity,'order',u,orderId);
  }
 }
 function release(items,u,orderId){
  for(const i of items){const p=get('SELECT id,sku,name,price,stock,active FROM products WHERE id=?',i.product_id);if(!p)fail(409,'Không tìm thấy sản phẩm để hoàn tồn.');movement(p,i.quantity,'cancel',u,orderId);}
 }
 function updateOrder(o,status,version,u){
  return atomic(()=>{
   const current=get('SELECT * FROM orders WHERE id=?',o.id);
   if(!Number.isSafeInteger(version)||current.version!==version)fail(409,'Đơn đã được cập nhật. Tải lại rồi thử.');
   if(current.status===status)return {ok:true};
   let inventory=current.inventory_state;
   const items=JSON.parse(current.items);
   if(status==='cancelled'&&inventory==='reserved'){release(items,u,current.id);inventory='released';}
   else if(status!=='cancelled'&&inventory==='released'){reserve(items,u,current.id);inventory='reserved';}
   run('UPDATE orders SET status=?,inventory_state=?,version=version+1,updated=? WHERE id=?',status,inventory,timestamp(),o.id);
   run('UPDATE conversations SET version=version+1 WHERE id=?',o.conversation_id);
   audit(u,o.conversation_id,'Cập nhật đơn hàng','CB'+o.id+' '+status);
   return {ok:true};
  });
 }
 function checkedRows(rows){
  if(!Array.isArray(rows)||!rows.length||rows.length>500)fail(400,'Mỗi lần nhập từ 1 đến 500 sản phẩm.');
  const seen=new Set(),errors=[],items=[];
  rows.forEach((row,i)=>{try{
   if(!row||typeof row!=='object')fail(400,'Dòng không hợp lệ.');
   const d=normalize(row);if(!row.sku?.trim())fail(400,'Nhập mã sản phẩm để kiểm tra trùng.');
   if(seen.has(d.sku))fail(400,'Mã bị trùng trong file: '+d.sku);
   if(get('SELECT id FROM products WHERE sku=? COLLATE NOCASE',d.sku))fail(409,'Mã đã có trong Choibox: '+d.sku);
   seen.add(d.sku);items.push({...d,row:row.row||i+2});
  }catch(e){errors.push({row:row?.row||i+2,message:e.message});}});
  return {items,errors};
 }
 async function importApi({p,req,body,u,send}){
  if(!['/api/products/import/preview','/api/products/import'].includes(p))return false;
  if(u.role!=='admin')fail(403,'Chỉ quản trị viên nhập sản phẩm.');
  if(req.method!=='POST')fail(405,'Thao tác không hỗ trợ.');
  if(p.endsWith('/preview')){const rows=await readProductFile(body),checked=checkedRows(rows);return send(200,{...checked,total:rows.length});}
  if(typeof body.request_id!=='string'||!/^[\w-]{10,80}$/.test(body.request_id))fail(400,'Thiếu mã lần nhập. Mở lại cửa sổ nhập file.');
  const digest=createHash('sha256').update(JSON.stringify(body.rows)).digest('hex');
  const result=atomic(()=>{
   const old=get('SELECT * FROM product_imports WHERE request_id=?',body.request_id);
   if(old){if(old.digest!==digest)fail(409,'Mã lần nhập đã dùng cho dữ liệu khác.');return {count:old.count,repeated:true};}
   const {items,errors}=checkedRows(body.rows);if(errors.length)fail(409,errors.map(e=>'Dòng '+e.row+': '+e.message).slice(0,6).join('\n'));
   const time=timestamp();
   for(const d of items){
    const id=Number(run('INSERT INTO products(sku,name,description,price,stock,active,created,updated) VALUES(?,?,?,?,?,?,?,?)',d.sku,d.name,d.description,d.price,d.stock,d.active,time,time).lastInsertRowid);
    if(d.stock)run('INSERT INTO stock_movements(product_id,delta,balance,reason,user_id,created) VALUES(?,?,?,?,?,?)',id,d.stock,d.stock,'import',u.id,time);
   }
   run('INSERT INTO product_imports(request_id,digest,count,created) VALUES(?,?,?,?)',body.request_id,digest,items.length,time);
   audit(u,null,'Nhập sản phẩm từ trang tính',items.length+' sản phẩm');
   return {count:items.length};
  });
  return send(200,result);
 }

 async function api({p,req,body,u,send}){
  if(await importApi({p,req,body,u,send}))return true;
  if(p==='/api/products'&&req.method==='GET')return send(200,state());
  const match=p.match(/^\/api\/products\/(\d+)(\/image)?$/);
  if(match&&match[2]&&req.method==='GET'){
   const product=get('SELECT image,image_type FROM products WHERE id=?',Number(match[1]));if(!product?.image?.length)fail(404,'Sản phẩm chưa có ảnh.');
   return send(200,Buffer.from(product.image),product.image_type,{'Cache-Control':'private, no-cache','Content-Security-Policy':"default-src 'none'; sandbox"});
  }
  if(p!=='/api/products'&&!match)return false;
  if(u.role!=='admin')fail(403,'Chỉ quản trị viên quản lý sản phẩm và nhập tồn kho.');
  if(!((p==='/api/products'&&req.method==='POST')||(match&&!match[2]&&req.method==='PATCH')))fail(405,'Thao tác không hỗ trợ.');
  const image=body.image===undefined?undefined:imageValue(body.image);
  const result=atomic(()=>{
   const id=match?Number(match[1]):null,old=id?get('SELECT '+columns+' FROM products WHERE id=?',id):null;
   if(id&&!old)fail(404,'Không tìm thấy sản phẩm.');
   if(old&&(!Number.isSafeInteger(body.version)||body.version!==old.version))fail(409,'Sản phẩm hoặc tồn kho đã thay đổi. Tải lại sản phẩm trước khi lưu.');
   const d=normalize(body,old||{}),duplicate=get('SELECT id FROM products WHERE sku=? COLLATE NOCASE',d.sku);
   if(duplicate&&duplicate.id!==id)fail(409,'Mã sản phẩm đã tồn tại.');
   const time=timestamp();let productId=id;
   if(old){
    run('UPDATE products SET sku=?,name=?,description=?,price=?,stock=?,active=?,version=version+1,updated=? WHERE id=?',d.sku,d.name,d.description,d.price,d.stock,d.active,time,id);
    if(image!==undefined)run('UPDATE products SET image=?,image_type=?,image_version=image_version+1 WHERE id=?',image.data,image.mime,id);
   }else{
    productId=Number(run('INSERT INTO products(sku,name,description,price,stock,active,image,image_type,image_version,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?)',d.sku,d.name,d.description,d.price,d.stock,d.active,image?.data??null,image?.mime??null,image?.data?1:0,time,time).lastInsertRowid);
   }
   const delta=d.stock-(old?.stock||0);
   if(delta)run('INSERT INTO stock_movements(product_id,delta,balance,reason,user_id,created) VALUES(?,?,?,?,?,?)',productId,delta,d.stock,old?'manual':'initial',u.id,time);
   audit(u,null,old?'Cập nhật sản phẩm và tồn kho':'Thêm sản phẩm',d.sku);
   return publicProduct(get('SELECT '+columns+' FROM products WHERE id=?',productId));
  });
  return send(match?200:201,result);
 }
 return {state,api,orderItems,reserve,updateOrder};
}
