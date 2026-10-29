import {workbookBuffer,csvBuffer,xlsxMime} from './spreadsheet-data.mjs';
const fail=(s,m)=>{throw Object.assign(Error(m),{status:s});};
export const orderStatuses={new:'Mới tạo',confirmed:'Đã xác nhận',shipping:'Đang giao',completed:'Hoàn tất',cancelled:'Đã huỷ'};
export function dateRange(search){
 const from=search.get('from'),to=search.get('to');
 for(const d of [from,to])if(!/^\d{4}-\d{2}-\d{2}$/.test(d||'')||!Number.isFinite(Date.parse(d+'T00:00:00Z'))||new Date(d+'T00:00:00Z').toISOString().slice(0,10)!==d)fail(400,'Chọn ngày bắt đầu và kết thúc hợp lệ.');
 const start=Date.parse(from+'T00:00:00+07:00'),end=Date.parse(to+'T00:00:00+07:00')+86400000;
 if(start>=end||end-start>366*86400000)fail(400,'Khoảng thời gian từ 1 đến 366 ngày.');
 return {from,to,start:new Date(start).toISOString(),end:new Date(end).toISOString()};
}
export function reporting({db,allowed,inventory}){
 const all=(s,...p)=>db.prepare(s).all(...p);
 async function api({p,req,body,u,send}){
  const search=new URL(req.url,'http://localhost').searchParams;
  if(p==='/api/products/template'&&req.method==='GET'){
   if(u.role!=='admin')fail(403,'Chỉ quản trị viên nhập sản phẩm.');
   return send(200,await workbookBuffer('San pham',['Mã sản phẩm','Tên sản phẩm','Nội dung','Đơn giá','Tồn kho','Trạng thái'],[['SP-MAU-001','Sản phẩm mẫu','Xoá dòng mẫu trước khi nhập dữ liệu thật',150000,10,'Đang bán']]),xlsxMime,{'Content-Disposition':'attachment; filename="Choibox-mau-san-pham.xlsx"'});
  }
  if(p==='/api/products/export'&&req.method==='POST'){
   if(!Array.isArray(body.ids)||body.ids.length>10000)fail(400,'Danh sách xuất không hợp lệ (tối đa 10.000 sản phẩm).');
   const ids=new Set(body.ids),rows=inventory.state().filter(p=>ids.has(p.id)).map(p=>[p.sku,p.name,p.description,p.price,p.stock,p.active?'Đang bán':'Ngừng bán']);
   const headers=['Mã sản phẩm','Tên sản phẩm','Nội dung','Đơn giá','Tồn kho','Trạng thái'];
   return send(200,body.format==='csv'?csvBuffer(headers,rows):await workbookBuffer('San pham',headers,rows),body.format==='csv'?'text/csv; charset=utf-8':xlsxMime,{'Content-Disposition':'attachment; filename="Choibox-san-pham.'+(body.format==='csv'?'csv':'xlsx')+'"'});
  }
  if(!['/api/reports','/api/orders/export'].includes(p)||req.method!=='GET')return false;
  const range=dateRange(search),channels=all('SELECT id,name,mode FROM channels').filter(c=>allowed(u,c.id)),ids=new Set(channels.map(c=>c.id));
  const allOrders=all('SELECT o.*,c.channel_id,ch.name channel_name,ch.mode FROM orders o JOIN conversations c ON c.id=o.conversation_id JOIN channels ch ON ch.id=c.channel_id WHERE julianday(o.created)>=julianday(?) AND julianday(o.created)<julianday(?) ORDER BY o.created DESC,o.id DESC',range.start,range.end).filter(o=>ids.has(o.channel_id));
  if(p==='/api/orders/export'){
   const status=search.get('status')||'all';if(status!=='all'&&!orderStatuses[status])fail(400,'Trạng thái đơn không hợp lệ.');
   const channel=search.get('channel')||'all';if(channel!=='all'&&!/^\d+$/.test(channel))fail(400,'Kênh không hợp lệ.');
   const rows=allOrders.filter(o=>(status==='all'||o.status===status)&&(channel==='all'||o.channel_id===Number(channel)));
   if(rows.length>10000)fail(413,'Quá 10.000 đơn. Chọn khoảng thời gian ngắn hơn.');
   const heads=['Mã đơn','Ngày tạo (giờ Việt Nam)','Khách hàng','Số điện thoại','Địa chỉ','Sản phẩm','Phí giao hàng','Giảm giá','Tổng tiền','Trạng thái','Kênh','Ghi chú'];
   const values=rows.map(o=>['CB'+String(o.id).padStart(6,'0'),new Date(o.created).toLocaleString('vi-VN',{timeZone:'Asia/Ho_Chi_Minh'}),o.customer,o.phone,o.address,JSON.parse(o.items).map(i=>i.quantity+' × '+i.name+' ('+i.price+' ₫)').join('\n'),o.shipping,o.discount,o.total,orderStatuses[o.status],o.channel_name,o.note]);
   const csv=search.get('format')==='csv';
   return send(200,csv?csvBuffer(heads,values):await workbookBuffer('Don hang',heads,values),csv?'text/csv; charset=utf-8':xlsxMime,{'Content-Disposition':'attachment; filename="Choibox-don-hang-'+range.from+'_'+range.to+'.'+(csv?'csv':'xlsx')+'"'});
  }
  const live=new Set(channels.filter(c=>c.mode==='live').map(c=>c.id)),counts={messages:0,incoming:0,outgoing:0,comments:0,notes:0,conversations:0,open:0,pending:0,closed:0,unassigned:0,awaiting:0,orders:0,new:0,confirmed:0,shipping:0,completed:0,cancelled:0,total:0,completed_total:0};
  const msgs=all("SELECT c.channel_id,c.kind conversation_kind,m.kind,COUNT(*) n,date(m.created,'+7 hours') day FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.local_deleted=0 AND c.hidden_local=0 AND julianday(m.created)>=julianday(?) AND julianday(m.created)<julianday(?) GROUP BY c.channel_id,c.kind,m.kind,day",range.start,range.end).filter(m=>live.has(m.channel_id));
  const days=new Map();for(let d=Date.parse(range.from+'T00:00:00Z');d<=Date.parse(range.to+'T00:00:00Z');d+=86400000)days.set(new Date(d).toISOString().slice(0,10),{day:new Date(d).toISOString().slice(0,10),incoming:0,outgoing:0,orders:0});
  for(const m of msgs){if(m.conversation_kind!=='comment'&&['incoming','outgoing'].includes(m.kind)){counts.messages+=m.n;counts[m.kind]+=m.n;if(days.has(m.day))days.get(m.day)[m.kind]+=m.n;}else if(m.kind==='note')counts.notes+=m.n;}
  const convs=all("SELECT c.*,(SELECT m.kind FROM messages m WHERE m.conversation_id=c.id AND m.local_deleted=0 AND m.kind IN ('incoming','outgoing') ORDER BY julianday(m.created) DESC,m.id DESC LIMIT 1) last_kind FROM conversations c WHERE c.hidden_local=0 AND EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.local_deleted=0 AND julianday(m.created)>=julianday(?) AND julianday(m.created)<julianday(?))",range.start,range.end).filter(c=>live.has(c.channel_id));
  counts.conversations=convs.length;
  for(const c of convs){if(['open','pending','closed'].includes(c.status))counts[c.status]++;if(c.assignee===null&&c.status!=='closed')counts.unassigned++;if(c.last_kind==='incoming'&&c.status!=='closed')counts.awaiting++;}
  counts.comments=all("SELECT c.channel_id,COUNT(*) n FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.kind='comment' AND c.hidden_local=0 AND m.local_deleted=0 AND m.kind IN ('incoming','outgoing') AND julianday(m.created)>=julianday(?) AND julianday(m.created)<julianday(?) GROUP BY c.channel_id",range.start,range.end).filter(c=>live.has(c.channel_id)).reduce((n,c)=>n+c.n,0);
  for(const o of allOrders.filter(o=>live.has(o.channel_id))){counts.orders++;if(o.status in orderStatuses)counts[o.status]++;if(o.status!=='cancelled')counts.total+=o.total;if(o.status==='completed')counts.completed_total+=o.total;const day=new Date(Date.parse(o.created)+7*3600000).toISOString().slice(0,10);if(days.has(day))days.get(day).orders++;}
  const staff=all('SELECT id,name FROM users WHERE active=1').map(u=>({id:u.id,name:u.name,open:convs.filter(c=>c.assignee===u.id&&c.status!=='closed').length,closed:convs.filter(c=>c.assignee===u.id&&c.status==='closed').length})).filter(s=>s.open||s.closed);
  return send(200,{range,counts,days:[...days.values()],staff});
 }
 return {api};
}
