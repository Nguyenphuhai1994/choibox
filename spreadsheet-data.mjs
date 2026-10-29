import {inflateRawSync} from 'node:zlib';
import ExcelJS from 'exceljs';
const fail=(s,m)=>{throw Object.assign(Error(m),{status:s});};
export const productHeaders=['Mã sản phẩm','Tên sản phẩm','Nội dung','Đơn giá','Tồn kho','Trạng thái'];
// Reject oversized ZIP containers before the workbook parser allocates XML trees.
export function inspectXlsx(b){
 const end=b.lastIndexOf(Buffer.from('504b0506','hex'));
 if(end<0||end+22>b.length||end+22+b.readUInt16LE(end+20)!==b.length)fail(400,'File Excel không hợp lệ.');
 const count=b.readUInt16LE(end+10),size=b.readUInt32LE(end+12),offset=b.readUInt32LE(end+16);
 if(!count||count>200||offset+size>end||count===65535)fail(400,'File Excel quá phức tạp. Dùng file mẫu và tối đa 500 sản phẩm.');
 let pos=offset,total=0;
 for(let n=0;n<count;n++){
  if(pos+46>b.length||b.readUInt32LE(pos)!==0x02014b50)fail(400,'Cấu trúc file Excel không hợp lệ.');
  const length=b.readUInt32LE(pos+24);total+=length;
  if(length>8*1024**2||total>16*1024**2)fail(413,'File Excel giải nén quá lớn.');
  const compressed=b.readUInt32LE(pos+20),local=b.readUInt32LE(pos+42),method=b.readUInt16LE(pos+10);
  if(local+30>b.length||b.readUInt32LE(local)!==0x04034b50||b.readUInt16LE(pos+8)&1||![0,8].includes(method))fail(400,'Kiểu nén Excel không hỗ trợ.');
  const dataStart=local+30+b.readUInt16LE(local+26)+b.readUInt16LE(local+28);
  if(dataStart+compressed>offset)fail(400,'Dữ liệu Excel không hợp lệ.');
  try{const payload=b.subarray(dataStart,dataStart+compressed),raw=method===8?inflateRawSync(payload,{maxOutputLength:8*1024**2}):payload;if(raw.length!==length)throw Error();}catch{fail(400,'Dữ liệu nén Excel không hợp lệ hoặc quá lớn.');}
  pos+=46+b.readUInt16LE(pos+28)+b.readUInt16LE(pos+30)+b.readUInt16LE(pos+32);
 }
 if(pos!==offset+size)fail(400,'Cấu trúc file Excel không hợp lệ.');
}
export function parseCSV(text){
 text=text.replace(/^\uFEFF/,'');
 const first=text.split(/\r?\n/,1)[0],sep=first.includes(';')&&!first.includes(',')?';':',';
 const rows=[];let row=[],cell='',quoted=false;
 for(let i=0;i<text.length;i++){
  const c=text[i];
  if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else if(quoted)quoted=false;else if(!cell)quoted=true;else fail(400,'Dấu ngoặc kép trong CSV không hợp lệ.');}
  else if(c===sep&&!quoted){row.push(cell);cell='';}
  else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);rows.push(row);row=[];cell='';}
  else cell+=c;
  if(cell.length>10000||row.length>30||rows.length>501)fail(400,'File tối đa 500 dòng, mỗi ô tối đa 10.000 ký tự.');
 }
 if(quoted)fail(400,'CSV thiếu dấu ngoặc kép đóng.');
 if(cell||row.length){row.push(cell);rows.push(row);}
 return rows;
}
export async function readProductFile({name,data}){
 if(typeof data!=='string'||data.length>2800000||!/^[A-Za-z0-9+/]*={0,2}$/.test(data))fail(400,'File không hợp lệ hoặc lớn hơn 2 MB.');
 const bytes=Buffer.from(data,'base64');if(!bytes.length||bytes.length>2*1024**2)fail(413,'File cần nhỏ hơn hoặc bằng 2 MB.');
 let rows;
 if(/\.csv$/i.test(name||''))rows=parseCSV(bytes.toString('utf8'));
 else if(/\.xlsx$/i.test(name||'')){
  inspectXlsx(bytes);const wb=new ExcelJS.Workbook();
  try{await wb.xlsx.load(bytes);}catch{fail(400,'Không đọc được file Excel. Tải file mẫu và nhập lại.');}
  const sheet=wb.worksheets[0];if(!sheet||sheet.rowCount>501||sheet.columnCount>30)fail(400,'Sheet đầu tiên tối đa 500 sản phẩm và 30 cột.');
  rows=[];sheet.eachRow({includeEmpty:true},r=>{const values=[];r.eachCell({includeEmpty:true},cell=>{
   const v=cell.value;
   if(v&&typeof v==='object'&&(v.formula||v.sharedFormula))fail(400,'File nhập không dùng công thức. Dán giá trị trước khi nhập.');
   values.push(v===null?'':typeof v==='object'?(v.richText?.map(t=>t.text).join('')??cell.text):v);
  });rows.push(values);});
 }else fail(400,'Chọn file .xlsx hoặc .csv theo mẫu.');
 if(!rows.length)fail(400,'File trống.');
 const normalize=s=>String(s??'').trim().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replaceAll('đ','d');
 const headers=rows.shift().map(normalize),keys=[['sku','Ma san pham'],['name','Ten san pham'],['description','Noi dung'],['price','Don gia'],['stock','Ton kho'],['active','Trang thai']];
 const indices=keys.map(([key,label])=>headers.findIndex(h=>h===key||h===normalize(label)));
 if(indices.some(i=>i<0)||new Set(indices).size!==6)fail(400,'Thiếu cột. Dùng đúng 6 cột trong file mẫu.');
 const result=rows.map((r,n)=>({r,n:n+2})).filter(({r})=>r.some(x=>String(x??'').trim())).map(({r,n})=>{
  const [sku,name,description,price,stock,active]=indices.map(i=>r[i]??''),a=normalize(active);
  return {row:n,sku:String(sku).trim(),name:String(name).trim(),description:String(description),price:price===''?NaN:Number(price),stock:stock===''?NaN:Number(stock),active:['1','dang ban','true'].includes(a)?true:['0','ngung ban','false'].includes(a)?false:null};
 });
 if(!result.length||result.length>500)fail(400,'Nhập từ 1 đến 500 sản phẩm mỗi lần.');
 return result;
}
export async function workbookBuffer(name,headers,rows){
 const w=new ExcelJS.Workbook();w.creator='Choibox · Choiagency';const s=w.addWorksheet(name,{views:[{state:'frozen',ySplit:1}]});
 s.addRow(headers);for(const row of rows)s.addRow(row.map(v=>v===undefined||v===null?'':typeof v==='string'?v.slice(0,32767):v));
 s.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};s.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF19654B'}};s.getRow(1).height=28;
 headers.forEach((h,i)=>s.getColumn(i+1).width=/Nội dung|Sản phẩm|Địa chỉ/.test(h)?42:/Tên|Khách/.test(h)?28:20);
 s.autoFilter={from:{row:1,column:1},to:{row:Math.max(1,s.rowCount),column:headers.length}};
 s.eachRow((r,i)=>{if(i>1){r.alignment={vertical:'top',wrapText:true};r.eachCell(c=>{if(typeof c.value==='number')c.numFmt='#,##0';});}});
 return Buffer.from(await w.xlsx.writeBuffer());
}
export function csvBuffer(headers,rows){
 const cell=v=>{let s=String(v??'');if(/^[\s]*[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
 return Buffer.from('\uFEFF'+[headers,...rows].map(r=>r.map(cell).join(',')).join('\r\n'),'utf8');
}
export const xlsxMime='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
