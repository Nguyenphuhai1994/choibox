import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {mediaCache} from './media-cache.mjs';
const DAY=86400000,MB=1024**2;
function fixture(t,options={}){
 const dir=fs.mkdtempSync(path.join(tmpdir(),'choibox-cache-')),db=new DatabaseSync(path.join(dir,'inbox.sqlite'));db.exec("CREATE TABLE messages(id INTEGER PRIMARY KEY,status TEXT,local_deleted INTEGER DEFAULT 0,body TEXT);CREATE TABLE attachments(id TEXT PRIMARY KEY,conversation_id INTEGER,name TEXT,mime TEXT,size INTEGER,data BLOB NOT NULL,created TEXT,message_id INTEGER)");
 let now=Date.now();const encrypt=x=>Buffer.from(JSON.stringify(x)).toString('base64'),decrypt=x=>JSON.parse(Buffer.from(x,'base64')),calls=[];
 const config={db,dataDir:dir,encrypt,decrypt,validUrl:u=>typeof u==='string'&&u.startsWith('https://test.zadn.vn/')?u:null,clock:()=>now,download:async url=>{calls.push(url);return {data:Buffer.from('media'),mime:'application/pdf'};},...options};let cache=mediaCache(config);
 t.after(()=>{cache.close();db.close();fs.rmSync(dir,{recursive:true,force:true});});
 function add({sent=true,source=true,created=now,legacy=null}={}){const id=randomUUID(),mid=sent?Number(db.prepare("INSERT INTO messages(status,body) VALUES('received','Giữ nguyên tin nhắn chữ')").run().lastInsertRowid):null;db.prepare('INSERT INTO attachments(id,conversation_id,name,mime,size,data,created,message_id,source) VALUES(?,1,?,?,?,?,?,?,?)').run(id,'test.pdf','application/pdf',legacy?.length||0,legacy||Buffer.alloc(0),new Date(created).toISOString(),mid,source?cache.source(['https://test.zadn.vn/file.pdf']):null);return id;}
 return {db,dir,calls,add,get cache(){return cache;},advance(ms){now+=ms;},reopen(){cache.close();cache=mediaCache(config);},row:id=>db.prepare('SELECT * FROM attachments WHERE id=?').get(id)};
}
test('Media downloads only on demand, shares in-flight work, reloads after TTL and keeps message text',async t=>{
 const f=fixture(t),id=f.add();assert.equal(f.calls.length,0);assert.equal(f.row(id).data.length,0);
 const results=await Promise.all([f.cache.load(id),f.cache.load(id)]);assert.equal(f.calls.length,1);assert.equal(results[0].data.toString(),'media');assert.equal(f.row(id).data.length,0);assert.equal(fs.readFileSync(path.join(f.dir,'media-cache',id)).toString(),'media');
 await f.cache.load(id);assert.equal(f.calls.length,1);f.advance(8*DAY);f.cache.cleanup();assert.equal(f.cache.stats().used_bytes,0);assert.equal(f.db.prepare('SELECT body FROM messages').get().body,'Giữ nguyên tin nhắn chữ');assert.ok(f.row(id).source);
 await f.cache.load(id);assert.equal(f.calls.length,2);assert.equal(f.cache.stats().used_bytes,5);f.reopen();assert.equal((await f.cache.load(id)).data.toString(),'media');assert.equal(f.calls.length,2);
});
test('Quota evicts the least recently accessed sent file; unsent and sending uploads are protected',async t=>{
 const f=fixture(t);f.cache.configure({days:7,max_bytes:25*MB});const data=Buffer.alloc(12*MB),a=f.add(),b=f.add(),c=f.add();f.cache.put(a,data);f.advance(1000);f.cache.put(b,data);f.advance(1000);await f.cache.load(a);f.advance(1000);f.cache.put(c,data);
 assert.equal(f.row(b).cache_disk,0);assert.equal(f.row(a).cache_disk,1);assert.equal(f.row(c).cache_disk,1);assert.equal(f.cache.stats().used_bytes,24*MB);
 f.cache.remove(a);f.cache.remove(c);const draft=f.add({sent:false}),sending=f.add();f.cache.put(draft,data);f.cache.put(sending,data);f.db.prepare("UPDATE messages SET status='sending' WHERE id=?").run(f.row(sending).message_id);
 assert.throws(()=>f.cache.put(f.add(),Buffer.alloc(2*MB)),e=>e.status===507);assert.equal(f.row(draft).cache_disk,1);assert.equal(f.row(sending).cache_disk,1);f.reopen();assert.equal(f.cache.stats().max_bytes,25*MB);
});
test('Expired URLs have a bounded retry, legacy blobs are cleared without deleting records, and orphan files are removed',async t=>{
 let calls=0;const f=fixture(t,{download:async()=>{calls++;return null;}}),id=f.add();await assert.rejects(f.cache.load(id),e=>e.status===410);await assert.rejects(f.cache.load(id),e=>e.status===410);assert.equal(calls,1);f.advance(61000);await assert.rejects(f.cache.load(id));assert.equal(calls,2);
 const old=f.add({source:false,created:Date.now()-9*DAY,legacy:Buffer.alloc(10000)});f.cache.cleanup();assert.equal(f.row(old).data.length,0);await assert.rejects(f.cache.load(old),e=>e.status===410);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM messages').get().n,2);
 const orphan=randomUUID();fs.writeFileSync(path.join(f.dir,'media-cache',orphan),'orphan');f.cache.cleanup();assert.ok(!fs.existsSync(path.join(f.dir,'media-cache',orphan)));f.cache.compact();assert.equal(f.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
 assert.equal(f.cache.source(['http://127.0.0.1/secret']),null);
});
test('Deleting a message or shutting down during a download cannot resurrect media',async t=>{
 let release;const f=fixture(t,{download:()=>new Promise(r=>release=r)}),id=f.add(),task=f.cache.load(id);await Promise.resolve();f.db.prepare('DELETE FROM attachments WHERE id=?').run(id);release({data:Buffer.from('private'),mime:'application/pdf'});await assert.rejects(task,e=>e.status===404);assert.ok(!fs.existsSync(path.join(f.dir,'media-cache',id)));
 const other=f.add(),pending=f.cache.load(other);await Promise.resolve();f.cache.close();release({data:Buffer.from('private'),mime:'application/pdf'});await assert.rejects(pending,e=>e.status===503);assert.equal(f.row(other).cache_disk,0);
});
