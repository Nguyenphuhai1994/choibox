// A successful pass means the returned pages reached the previous checkpoint.
// It is not a claim that Zalo exposed every message retained on the phone.
const labels={scanning:'Đang rà tin khi máy chủ ngoại tuyến…',reached:'Đã rà tới mốc đồng bộ đã lưu',limited:'Chưa xác minh đủ lịch sử; có thể tiếp tục rà',timeout:'Zalo chưa trả lời lượt rà lịch sử',interrupted:'Lượt rà bị ngắt; sẽ thử lại khi kết nối',error:'Chưa rà được lịch sử từ Zalo'};
export function zaloRecovery({db,ingest,clock=Date.now,maxPages=40,pageDelayMs=750,requestTimeoutMs=20000,heartbeatMs=15000}){
 const get=(q,...a)=>db.prepare(q).get(...a),all=(q,...a)=>db.prepare(q).all(...a),run=(q,...a)=>db.prepare(q).run(...a);
 db.exec(`CREATE TABLE IF NOT EXISTS zalo_recovery(channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,type INTEGER NOT NULL,gap_from INTEGER NOT NULL,scan_until INTEGER NOT NULL,last_online INTEGER NOT NULL,status TEXT NOT NULL,cursor TEXT,pages INTEGER DEFAULT 0,imported INTEGER DEFAULT 0,checked INTEGER DEFAULT 0,PRIMARY KEY(channel_id,type));`);
 run("UPDATE zalo_recovery SET status='interrupted' WHERE status='scanning'");
 const sessions=new Map();let closed=false;
 function row(id,type){return get('SELECT * FROM zalo_recovery WHERE channel_id=? AND type=?',id,type);}
 function clearTask(task){clearTimeout(task.timer);clearTimeout(task.delay);task.timer=null;task.delay=null;task.waiting=false;}
 function valid(id,s){return !closed&&sessions.get(id)===s;}
 function finish(id,type,s,status){const task=s.tasks.get(type);if(!task||!valid(id,s))return;clearTask(task);task.active=false;run('UPDATE zalo_recovery SET status=?,checked=? WHERE channel_id=? AND type=?',status,clock(),id,type);}
 function request(id,type,s){
  const task=s.tasks.get(type);if(!valid(id,s)||!task?.active)return;
  task.waiting=true;task.timer=setTimeout(()=>finish(id,type,s,'timeout'),requestTimeoutMs);task.timer.unref?.();
  try{s.request(type,task.cursor||null);}catch{finish(id,type,s,'error');}
 }
 function begin(id,type,s,{resume=false}={}){
  const old=row(id,type),pending=old&&old.status!=='reached',initial=!old;
  const latest=get(`SELECT MAX(m.created) value FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.channel_id=? AND c.thread_type=? AND m.local_deleted=0`,id,type===1?'group':'user')?.value;
  const time=clock(),lastEvent=get('SELECT last_event FROM channels WHERE id=?',id)?.last_event,rawKnown=Date.parse(latest||lastEvent||''),known=Number.isFinite(rawKnown)?Math.min(time,rawKnown):NaN;
  // Keep an unresolved gap independent of the online heartbeat, including across restarts.
  const from=pending?old.gap_from:old?Math.max(0,old.last_online-120000):Number.isFinite(known)?Math.max(0,known-120000):time;
  const cursor=resume&&pending?old.cursor:null,upper=resume&&pending?old.scan_until:time;
  const task={active:true,waiting:false,cursor,seen:new Set(cursor?[cursor]:[]),roundPages:0,recoveryFrom:initial&&!Number.isFinite(known)?null:from};s.tasks.set(type,task);
  run(`INSERT INTO zalo_recovery(channel_id,type,gap_from,scan_until,last_online,status,cursor,pages,imported,checked) VALUES(?,?,?,?,?,'scanning',?,0,0,?) ON CONFLICT(channel_id,type) DO UPDATE SET gap_from=excluded.gap_from,scan_until=excluded.scan_until,status='scanning',cursor=excluded.cursor,pages=0,imported=0,checked=excluded.checked`,id,type,from,upper,time,cursor, time);
  request(id,type,s);
 }
 function heartbeat(id,s){if(!valid(id,s))return;const time=clock();if(heartbeatMs&&time-s.lastBeat>heartbeatMs*3){for(const [type,t] of s.tasks){clearTask(t);begin(id,type,s);}}s.lastBeat=time;run('UPDATE zalo_recovery SET last_online=? WHERE channel_id=?',time,id);}
 function disconnect(id){const s=sessions.get(id);if(!s)return;if(!heartbeatMs||clock()-s.lastBeat<=heartbeatMs*3)run('UPDATE zalo_recovery SET last_online=? WHERE channel_id=?',clock(),id);for(const [type,t] of s.tasks){if(t.active)finish(id,type,s,'interrupted');else clearTask(t);}clearInterval(s.heartbeat);sessions.delete(id);}
 function connect(id,requestPage){
  disconnect(id);if(closed)return;const s={request:requestPage,tasks:new Map(),lastBeat:clock()};sessions.set(id,s);
  for(const type of [0,1])begin(id,type,s);
  if(heartbeatMs){s.heartbeat=setInterval(()=>heartbeat(id,s),heartbeatMs);s.heartbeat.unref?.();}
 }
 function page(id,type,events){
  const s=sessions.get(id),task=s?.tasks.get(type);
  if(!s||!valid(id,s)||![0,1].includes(type)||!Array.isArray(events))return false;
  if(!task?.active||!task.waiting)return false;
  clearTimeout(task.timer);task.timer=null;task.waiting=false;
  const state=row(id,type),time=clock();let imported=0,invalid=false;
  const parsed=[];
  for(const e of events.slice(0,2000)){
   if(e?.type!==type||!/^\d+$/.test(String(e.threadId||''))||!/^\d+$/.test(String(e.data?.msgId||''))||!Number.isFinite(new Date(Number(e.data?.ts)).getTime())||Number(e.data.ts)<=0){invalid=true;continue;}
   parsed.push({event:e,id:String(e.data.msgId),time:Number(e.data.ts)});
  }
  // Save a whole page before moving its cursor, so an interrupted write is safe to replay.
  try{for(const item of parsed){if(ingest(id,item.event,task.recoveryFrom))imported++;}}catch{finish(id,type,s,'error');return true;}
  task.roundPages++;run('UPDATE zalo_recovery SET pages=pages+1,imported=imported+?,checked=? WHERE channel_id=? AND type=?',imported,time,id,type);
  if(invalid||events.length>2000){finish(id,type,s,'limited');return true;}
  if(!parsed.length){finish(id,type,s,'limited');return true;}
  parsed.sort((a,b)=>a.time-b.time||(BigInt(a.id)<BigInt(b.id)?-1:BigInt(a.id)>BigInt(b.id)?1:0));
  if(parsed[0].time<=state.gap_from){finish(id,type,s,'reached');return true;}
  const cursor=parsed[0].id;
  if(task.seen.has(cursor)){finish(id,type,s,'limited');return true;}
  task.seen.add(cursor);task.cursor=cursor;
  run('UPDATE zalo_recovery SET cursor=? WHERE channel_id=? AND type=?',cursor,id,type);
  if(task.roundPages>=maxPages){finish(id,type,s,'limited');return true;}
  task.delay=setTimeout(()=>request(id,type,s),pageDelayMs);task.delay.unref?.();return true;
 }
 function retry(id,{restart=false}={}){
  const s=sessions.get(id);if(!s)throw Object.assign(Error('Kênh Zalo chưa kết nối.'),{status:409});
  if([...s.tasks.values()].some(t=>t.active))throw Object.assign(Error('Đang rà lịch sử. Vui lòng chờ.'),{status:409});
  for(const type of [0,1])if(restart||row(id,type)?.status!=='reached')begin(id,type,s,{resume:!restart});
 }
 function state(id){return all('SELECT type,status,gap_from,scan_until,last_online,pages,imported,checked FROM zalo_recovery WHERE channel_id=? ORDER BY type',id).map(r=>({...r,label:r.type===1?'Nhóm':'Chat riêng',message:labels[r.status]||labels.interrupted}));}
 function close(){if(closed)return;for(const id of [...sessions.keys()])disconnect(id);closed=true;}
 return {connect,disconnect,page,retry,state,close};
}
