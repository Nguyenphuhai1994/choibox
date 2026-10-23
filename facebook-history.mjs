// Read-only Graph requests. Cursors are opaque values, never URLs to follow.
export function facebookHistory({db,decrypt,transport}) {
 const get=(s,...p)=>db.prepare(s).get(...p),run=(s,...p)=>db.prepare(s).run(...p);
 db.exec(`CREATE TABLE IF NOT EXISTS facebook_history(conversation_id INTEGER PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,thread_id TEXT,after_cursor TEXT,complete INTEGER DEFAULT 0);
 CREATE TABLE IF NOT EXISTS facebook_history_pages(channel_id INTEGER PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,after_cursor TEXT);`);
 const busy=new Set(),profiles=new Map();
 async function graph(ch,path,params={}) {const s=decrypt(ch.secret);const u=new URL(`https://graph.facebook.com/${s.graph_version}/${path}`);u.search=new URLSearchParams(params);return transport(u.href,{headers:{Authorization:'Bearer '+s.access_token}});}
 function remember(ch,t) {
  const people=t.participants?.data||[],person=people.find(p=>String(p.id)!==ch.external_id);
  if(!person||!/^\d+$/.test(String(person.id))||!t.id)return null;
  const name=String(person.name||person.id).trim().slice(0,200);
  run('INSERT OR IGNORE INTO conversations(channel_id,external_id,name,updated) VALUES(?,?,?,?)',ch.id,String(person.id),name,new Date().toISOString());
  const c=get('SELECT * FROM conversations WHERE channel_id=? AND external_id=?',ch.id,String(person.id));
  if(c.hidden_local)return null;
  if(c.name===c.external_id&&name!==c.external_id)run('UPDATE conversations SET name=?,version=version+1 WHERE id=?',name,c.id);
  run('INSERT OR IGNORE INTO facebook_history(conversation_id,thread_id) VALUES(?,?)',c.id,String(t.id));return c;
 }
 async function profile(c) {
  const ch=get('SELECT * FROM channels WHERE id=?',c.channel_id);
  if(!ch||ch.provider!=='facebook'||ch.mode!=='live'||!ch.enabled||c.kind==='comment'||c.name!==c.external_id)return;
  if((profiles.get(c.id)||0)>Date.now())return;profiles.set(c.id,Date.now()+300000);
  try {const d=await graph(ch,ch.external_id+'/conversations',{platform:'messenger',user_id:c.external_id,fields:'id,participants',limit:'5'});for(const t of d.data||[])if(t.participants?.data?.some(p=>String(p.id)===c.external_id))remember(ch,t);}catch{/* Keep messages usable if Meta denies profile access. */}
 }
 async function messages(ch,c) {
  const h=get('SELECT * FROM facebook_history WHERE conversation_id=?',c.id);if(!h||h.complete)return {added:0,more:false};
  const params={fields:'id,message,from,created_time',limit:'50'};if(h.after_cursor)params.after=h.after_cursor;
  const d=await graph(ch,encodeURIComponent(h.thread_id)+'/messages',params);let added=0;
  db.exec('BEGIN IMMEDIATE');try {
   for(const m of d.data||[]){if(!m.id||!m.from?.id||!Number.isFinite(Date.parse(m.created_time)))continue;
    if(c.deleted_before&&new Date(m.created_time).toISOString()<=c.deleted_before)continue;
    if(get('SELECT id FROM messages WHERE conversation_id=? AND external_id=?',c.id,m.id))continue;
    const kind=String(m.from.id)===ch.external_id?'outgoing':'incoming';
    run('INSERT INTO messages(conversation_id,external_id,kind,body,created,status) VALUES(?,?,?,?,?,?)',c.id,String(m.id),kind,String(m.message||'[Tin đính kèm]').slice(0,12000),new Date(m.created_time).toISOString(),kind==='incoming'?'received':'sent');added++;
   }
   const cursor=d.paging?.next&&d.paging?.cursors?.after||null;
   run('UPDATE facebook_history SET after_cursor=?,complete=? WHERE conversation_id=?',cursor,cursor?0:1,c.id);
   if(added)run('UPDATE conversations SET updated=(SELECT MAX(created) FROM messages WHERE conversation_id=?),version=version+1 WHERE id=?',c.id,c.id);
   db.exec('COMMIT');return {added,more:!!cursor};
  }catch(e){db.exec('ROLLBACK');throw e;}
 }
 async function sync(ch,c=null) {
  if(ch.provider!=='facebook'||ch.mode!=='live'||!ch.enabled)throw Error('Chỉ đồng bộ Facebook Page đang bật.');
  if(busy.has(ch.id))throw Error('Kênh đang đồng bộ. Vui lòng chờ.');busy.add(ch.id);
  try {
   if(c){if(c.kind==='comment')throw Error('Chức năng này dành cho tin nhắn.');
    if(!get('SELECT * FROM facebook_history WHERE conversation_id=?',c.id)){const d=await graph(ch,ch.external_id+'/conversations',{platform:'messenger',user_id:c.external_id,fields:'id,participants',limit:'5'});for(const t of d.data||[])if(t.participants?.data?.some(p=>String(p.id)===c.external_id))remember(ch,t);}
    if(!get('SELECT * FROM facebook_history WHERE conversation_id=?',c.id))throw Error('Facebook chưa trả về lịch sử hội thoại này.');return await messages(ch,c);
   }
   const state=get('SELECT * FROM facebook_history_pages WHERE channel_id=?',ch.id),params={platform:'messenger',fields:'id,participants',limit:'5'};if(state?.after_cursor)params.after=state.after_cursor;
   const d=await graph(ch,ch.external_id+'/conversations',params);let added=0,threads=0;
   for(const t of d.data||[]){const co=remember(ch,t);if(co){added+=(await messages(ch,co)).added;threads++;}}
   const cursor=d.paging?.next&&d.paging?.cursors?.after||null;run('INSERT INTO facebook_history_pages(channel_id,after_cursor) VALUES(?,?) ON CONFLICT(channel_id) DO UPDATE SET after_cursor=excluded.after_cursor',ch.id,cursor);
   return {added,threads,more:!!cursor};
  }finally{busy.delete(ch.id);}
 }
 return {profile,sync,busy};
}
