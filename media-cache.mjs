import fs from 'node:fs';
import path from 'node:path';

const DAY=86400000,EMPTY=Buffer.alloc(0);
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
// Only opaque attachment IDs are used as paths. Provider URLs stay encrypted in SQLite.
export function mediaCache({db,dataDir,encrypt,decrypt,download,validUrl,resolveSource,clock=Date.now,intervalMs=900000}){
 const get=(s,...p)=>db.prepare(s).get(...p),all=(s,...p)=>db.prepare(s).all(...p),run=(s,...p)=>db.prepare(s).run(...p);
 const columns=all('PRAGMA table_info(attachments)').map(c=>c.name);
 for(const [name,type] of Object.entries({source:'TEXT',media_kind:"TEXT DEFAULT 'file'",cache_disk:'INTEGER DEFAULT 0',cached_at:'INTEGER DEFAULT 0',accessed_at:'INTEGER DEFAULT 0',retry_at:'INTEGER DEFAULT 0',cache_error:"TEXT DEFAULT ''"}))if(!columns.includes(name))db.exec(`ALTER TABLE attachments ADD COLUMN ${name} ${type}`);
 // Existing local files get the normal retention window from the upgrade date.
 if(!columns.includes('cached_at'))run('UPDATE attachments SET cached_at=?,accessed_at=? WHERE length(data)>0',clock(),clock());
 db.exec('CREATE TABLE IF NOT EXISTS media_settings(id INTEGER PRIMARY KEY CHECK(id=1),days INTEGER NOT NULL,max_bytes INTEGER NOT NULL)');
 run('INSERT OR IGNORE INTO media_settings VALUES(1,7,?)',2*1024**3);
 const folder=path.join(dataDir,'media-cache');fs.mkdirSync(folder,{recursive:true,mode:0o700});fs.chmodSync(folder,0o700);
 const file=id=>{if(!/^[a-f0-9-]{16,80}$/.test(id))fail(400,'Mã tệp không hợp lệ.');return path.join(folder,id);};
 let closed=false,active=0;const pending=new Map();
 const settings=()=>get('SELECT days,max_bytes FROM media_settings WHERE id=1');
 const hasTable=t=>!!get("SELECT name FROM sqlite_master WHERE type='table' AND name=?",t);
 function avatarRows(){const rows=[];
  if(hasTable('customer_profiles'))rows.push(...all('SELECT conversation_id id,length(avatar) bytes,avatar_updated stamp FROM customer_profiles WHERE avatar IS NOT NULL').map(r=>({...r,table:'customer_profiles'})));
  if(hasTable('zalo_author_avatars'))rows.push(...all('SELECT channel_id id,author_id,length(avatar) bytes,checked stamp FROM zalo_author_avatars WHERE avatar IS NOT NULL').map(r=>({...r,table:'zalo_author_avatars'})));
  return rows;
 }
 function used(){return Number(get('SELECT COALESCE(SUM(CASE WHEN cache_disk=1 THEN size ELSE length(data) END),0) n FROM attachments').n)+avatarRows().reduce((s,r)=>s+r.bytes,0);}
 function evict(a){try{fs.unlinkSync(file(a.id));}catch(e){if(e.code!=='ENOENT')throw e;}run('UPDATE attachments SET data=?,cache_disk=0,cached_at=0 WHERE id=?',EMPTY,a.id);}
 function evictAvatar(a){if(a.table==='customer_profiles')run("UPDATE customer_profiles SET avatar=NULL,avatar_type=NULL,avatar_updated=0,retry_at=0,profile_status='pending' WHERE conversation_id=?",a.id);else run('UPDATE zalo_author_avatars SET avatar=NULL,avatar_type=NULL,retry_at=0 WHERE channel_id=? AND author_id=?',a.id,a.author_id);}
 function cleanup({reserve=0,exclude=''}={}){
  if(closed)return;const cfg=settings(),now=clock(),cutoff=now-cfg.days*DAY;
  // Sending files and current uploads must survive cleanup. Abandoned drafts expire after a day.
  const rows=all("SELECT a.id,a.size,a.cache_disk,a.cached_at,a.accessed_at,a.created,length(a.data) bytes,m.status FROM attachments a LEFT JOIN messages m ON m.id=a.message_id WHERE (a.cache_disk=1 OR length(a.data)>0) AND (a.message_id IS NOT NULL OR a.created<?) AND COALESCE(m.status,'')!='sending'",new Date(now-DAY).toISOString()).filter(a=>a.id!==exclude&&!pending.has(a.id));
  for(const a of rows)if((a.cached_at||Date.parse(a.created)||now)<cutoff)evict(a);
  for(const a of avatarRows())if(a.stamp&&a.stamp<cutoff)evictAvatar(a);
  let total=used();if(total+reserve>cfg.max_bytes){
   const candidates=[...rows.filter(a=>get('SELECT cache_disk OR length(data)>0 ok FROM attachments WHERE id=?',a.id)?.ok).map(a=>({...a,stamp:a.accessed_at||a.cached_at||Date.parse(a.created),bytes:a.cache_disk?a.size:a.bytes})),...avatarRows()];
   candidates.sort((a,b)=>(a.stamp||0)-(b.stamp||0));for(const a of candidates){if(total+reserve<=cfg.max_bytes)break;a.table?evictAvatar(a):evict(a);total-=a.bytes;}
  }
  // A crash or deleting a message/channel can leave an orphan on disk; never follow symlinks.
  for(const entry of fs.readdirSync(folder,{withFileTypes:true})){if(/^[a-f0-9-]{16,80}\.tmp$/.test(entry.name)){const p=path.join(folder,entry.name);try{if(fs.lstatSync(p).mtimeMs<now-3600000)fs.unlinkSync(p);}catch{}continue;}if(!/^[a-f0-9-]{16,80}$/.test(entry.name))continue;const row=get('SELECT cache_disk FROM attachments WHERE id=?',entry.name);if(!row?.cache_disk&&!pending.has(entry.name))try{fs.unlinkSync(path.join(folder,entry.name));}catch{}}
  try{db.exec('PRAGMA incremental_vacuum(128)');}catch{/* Old databases may not use incremental vacuum. */}
 }
 function put(id,data){
  if(closed)fail(503,'Choibox đang dừng.');cleanup({reserve:data.length,exclude:id});const old=get('SELECT cache_disk,size,length(data) bytes FROM attachments WHERE id=?',id);if(!old)fail(404,'Tệp đã xoá.');
  const previous=old.cache_disk?old.size:old.bytes;if(used()-previous+data.length>settings().max_bytes)fail(507,'Bộ nhớ đệm đang đầy. Hãy gửi hoặc bỏ các tệp đang chờ, hoặc tăng giới hạn lưu tạm.');
  const target=file(id),tmp=target+'.tmp';try{fs.writeFileSync(tmp,data,{mode:0o600});fs.renameSync(tmp,target);run('UPDATE attachments SET data=?,cache_disk=1,cached_at=?,accessed_at=?,size=?,retry_at=0,cache_error=\'\' WHERE id=?',EMPTY,clock(),clock(),data.length,id);}catch(e){try{fs.unlinkSync(tmp);}catch{}if(e.code==='ENOSPC')fail(507,'Ổ đĩa máy chủ không còn đủ chỗ trống để tải tệp.');throw e;}
 }
 function bytes(a){
  if(a.cache_disk){try{const p=file(a.id);if(!fs.lstatSync(p).isFile()||fs.lstatSync(p).isSymbolicLink())return null;return fs.readFileSync(p);}catch{return null;}}
  return a.data?.length?Buffer.from(a.data):null;
 }
 function describe(a){return {id:a.id,name:a.name,mime:a.mime,size:a.size,media_kind:a.media_kind,cached:!!(a.cache_disk||a.has_data||a.data?.length),can_reload:!!a.source};}
 function remove(id){const a=get('SELECT id FROM attachments WHERE id=?',id);if(a)evict(a);}
 async function load(id){
  const row=()=>get('SELECT * FROM attachments WHERE id=?',id);let a=row();if(!a)fail(404,'Không tìm thấy tệp.');
  const m=a.message_id&&get('SELECT local_deleted FROM messages WHERE id=?',a.message_id);if(m?.local_deleted)fail(404,'Tệp đã xoá.');
  const cfg=settings(),expired=(a.cached_at||Date.parse(a.created)||clock())<clock()-cfg.days*DAY;
  const protectedFile=!a.message_id||get('SELECT status FROM messages WHERE id=?',a.message_id)?.status==='sending';
  let data=(!expired||protectedFile)&&bytes(a);if(data){run('UPDATE attachments SET accessed_at=? WHERE id=?',clock(),id);return {...a,data};}
  if(expired&&!protectedFile){evict(a);a=row();}
  if(!a.source)fail(410,'Bản lưu tạm đã được dọn và tệp này không có đường dẫn tải lại. Hãy mở tin gốc trên Facebook/Zalo.');
  if(pending.has(id))return pending.get(id);if(a.retry_at>clock())fail(410,a.cache_error||'Chưa tải lại được tệp.');if(pending.size>=4)fail(429,'Đang tải nhiều tệp. Vui lòng thử lại sau.');
  const task=Promise.resolve().then(async()=>{active++;try{
   const source=decrypt(a.source);let result;
   if(source.provider){if(!resolveSource)fail(410,'Kênh này chưa hỗ trợ mở lại tệp.');result=await resolveSource(source,a);}
   else for(const url of source.urls||[]){if(closed)fail(503,'Choibox đang dừng.');result=await download(url,a);if(result?.data?.length)break;}
   if(closed)fail(503,'Choibox đang dừng.');a=row();if(!a||a.message_id&&get('SELECT local_deleted FROM messages WHERE id=?',a.message_id)?.local_deleted)fail(404,'Tệp đã xoá.');
   if(!result?.data?.length)fail(410,'Không tải lại được tệp từ nền tảng; đường dẫn có thể đã hết hạn. Hãy mở tin gốc trên Facebook/Zalo.');
   put(id,result.data);run('UPDATE attachments SET mime=? WHERE id=?',result.mime,id);return {...row(),data:result.data};
  }catch(e){if(!closed&&row())run('UPDATE attachments SET retry_at=?,cache_error=? WHERE id=?',clock()+60000,e.status?e.message:'Không tải được tệp từ nền tảng. Vui lòng thử lại hoặc mở tin gốc.',id);if(!e.status)fail(502,'Không tải được tệp từ nền tảng. Vui lòng thử lại hoặc mở tin gốc.');throw e;
  }finally{active--;pending.delete(id);}});pending.set(id,task);return task;
 }
 function source(urls){const safe=[...new Set(urls.map(validUrl).filter(Boolean))].slice(0,6);return safe.length?encrypt({urls:safe}):null;}
 function stats(){const s=settings(),file=path.join(dataDir,'inbox.sqlite'),size=p=>fs.existsSync(p)?fs.statSync(p).size:0;return {...s,used_bytes:used(),database_bytes:size(file)+size(file+'-wal'),reusable_database_bytes:Number(get('PRAGMA freelist_count').freelist_count)*Number(get('PRAGMA page_size').page_size)};}
 function configure({days,max_bytes}){if(!Number.isInteger(days)||days<1||days>90||!Number.isSafeInteger(max_bytes)||max_bytes<25*1024**2||max_bytes>100*1024**3)fail(400,'Chọn 1–90 ngày và giới hạn từ 25 MB đến 100 GB.');run('UPDATE media_settings SET days=?,max_bytes=? WHERE id=1',days,max_bytes);cleanup();return stats();}
 function compact(){if(active||get("SELECT id FROM messages WHERE status='sending'"))fail(409,'Đang tải hoặc gửi tệp. Vui lòng chờ.');const info=stats(),space=fs.statfsSync(dataDir);if(space.bavail*space.bsize<info.database_bytes+50*1024**2)fail(507,'Chưa đủ ổ đĩa trống để thu gọn an toàn. Cần thêm khoảng một lần dung lượng cơ sở dữ liệu.');db.exec('VACUUM');db.exec('PRAGMA wal_checkpoint(TRUNCATE)');return stats();}
 const timer=setInterval(()=>{try{cleanup();}catch{/* Retry next time; never stop receiving messages. */}},intervalMs);timer.unref?.();
 // Startup cleanup runs after all provider tables have been created.
 const startup=setTimeout(()=>{try{cleanup();}catch{}},0);startup.unref?.();
 return {load,put,bytes,describe,source,remove,cleanup,stats,configure,compact,close(){closed=true;clearInterval(timer);clearTimeout(startup);}};
}
