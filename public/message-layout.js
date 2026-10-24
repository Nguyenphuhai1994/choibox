const dayKey=value=>{const d=new Date(value);return Number.isFinite(+d)?`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`:null;};
const author=m=>m.author_id?`author:${m.author_id}`:m.sender_id?`staff:${m.sender_id}`:`name:${m.sender_name||m.author_name||''}`;
export function sameMessageGroup(a,b){
 if(!a||!b||['note','order'].includes(a.kind)||a.kind!==b.kind)return false;
 const delta=new Date(b.created)-new Date(a.created);
 return dayKey(a.created)!==null&&dayKey(a.created)===dayKey(b.created)&&delta>=0&&delta<300000&&author(a)===author(b);
}
export function messageLayout(items){return items.map((m,i)=>({
 newDay:i===0||dayKey(items[i-1].created)!==dayKey(m.created),
 continued:sameMessageGroup(items[i-1],m),
 showTime:!sameMessageGroup(m,items[i+1]),
 day:new Date(m.created).toLocaleDateString('vi-VN'),
 time:new Date(m.created).toLocaleTimeString('vi-VN',{hour:'2-digit',minute:'2-digit'}),
 fullTime:new Date(m.created).toLocaleString('vi-VN')
}));}
