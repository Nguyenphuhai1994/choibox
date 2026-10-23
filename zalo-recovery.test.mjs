import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {zaloRecovery} from './zalo-recovery.mjs';
const base=1800000000000,day=86400000;
const event=(id,time,type=0)=>({type,threadId:'222',isSelf:false,data:{msgId:String(id),ts:String(time),content:'Test'}});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function fixture(t,options={}){
 const db=new DatabaseSync(':memory:');db.exec("PRAGMA foreign_keys=ON;CREATE TABLE channels(id INTEGER PRIMARY KEY,last_event TEXT);INSERT INTO channels(id) VALUES(1);CREATE TABLE conversations(id INTEGER PRIMARY KEY,channel_id INTEGER,thread_type TEXT);CREATE TABLE messages(id INTEGER PRIMARY KEY,conversation_id INTEGER,created TEXT,local_deleted INTEGER DEFAULT 0);");
 let time=base+day;const calls=[],saved=new Set(),received=[];
 const settings={db,clock:()=>time,pageDelayMs:1,requestTimeoutMs:5000,heartbeatMs:0,ingest:(id,e,from)=>{received.push({id,e,from});const key=e.type+':'+e.data.msgId;if(saved.has(key))return false;saved.add(key);return true;},...options};
 let engine=zaloRecovery(settings);
 function seed(){for(const type of [0,1])db.prepare("INSERT INTO zalo_recovery(channel_id,type,gap_from,scan_until,last_online,status,checked) VALUES(1,?,?,?,?,?,?)").run(type,base,base,base,'reached',base);}
 const connect=()=>engine.connect(1,(type,cursor)=>calls.push({type,cursor}));
 t.after(()=>{engine.close();db.close();});
 return {db,calls,saved,received,seed,connect,get engine(){return engine;},setTime(v){time=v;},reopen(){engine.close();engine=zaloRecovery(settings);connect();}};
}
test('Offline recovery follows pages to a persistent checkpoint for direct and group messages',async t=>{
 const f=fixture(t);f.seed();f.connect();assert.deepEqual(f.calls,[{type:0,cursor:null},{type:1,cursor:null}]);
 f.engine.page(1,0,[event('90071992547409933',base+50000),event('90071992547409934',base+day)]);await wait(5);assert.equal(f.calls.at(-1).cursor,'90071992547409933');
 f.engine.page(1,0,[event('90071992547409932',base-120001),event('90071992547409933',base+50000)]);
 f.engine.page(1,1,[event('90',base-120001,1),event('91',base+day,1)]);
 assert.ok(f.engine.state(1).every(s=>s.status==='reached'));assert.equal(f.engine.state(1)[0].imported,3);assert.equal(f.saved.size,5);assert.ok(f.received.every(x=>x.from===base-120000));
});
test('Page limits preserve the unresolved gap while retry resumes and restart rereads the head',async t=>{
 const f=fixture(t,{maxPages:1});f.seed();f.connect();f.engine.page(1,0,[event('100',base+50000)]);f.engine.page(1,1,[]);
 const original=f.engine.state(1)[0].gap_from;assert.equal(f.engine.state(1)[0].status,'limited');f.engine.retry(1);assert.ok(f.calls.some(c=>c.type===0&&c.cursor==='100'));
 f.engine.page(1,0,[event('99',base+40000)]);f.engine.page(1,1,[]);f.setTime(base+day*2);f.reopen();assert.deepEqual(f.calls.slice(-2),[{type:0,cursor:null},{type:1,cursor:null}]);assert.equal(f.engine.state(1)[0].gap_from,original);
});
test('Empty, repeated, malformed and timed-out pages remain incomplete instead of advancing coverage',async t=>{
 const f=fixture(t,{requestTimeoutMs:30});f.seed();f.connect();f.engine.page(1,0,[]);assert.equal(f.engine.state(1)[0].status,'limited');await wait(50);assert.equal(f.engine.state(1)[1].status,'timeout');
 f.engine.retry(1);f.engine.page(1,0,[event('100',base+10000)]);await wait(5);f.engine.page(1,0,[event('100',base+10000)]);assert.equal(f.engine.state(1)[0].status,'limited');
 f.engine.page(1,1,[{...event('101',base+10000,1),data:{msgId:'bad',ts:base}}]);assert.equal(f.engine.state(1)[1].status,'limited');assert.ok(f.engine.state(1).every(s=>s.gap_from===base-120000));
});
test('A sleep/wake clock gap starts another scan before the online heartbeat can hide the offline window',async t=>{
 const f=fixture(t,{heartbeatMs:10});f.setTime(base);f.seed();f.connect();for(const type of [0,1])f.engine.page(1,type,[event('100',base-120001,type)]);
 assert.ok(f.engine.state(1).every(s=>s.status==='reached'));f.setTime(base+day);await wait(25);
 assert.ok(f.calls.length>=4);assert.ok(f.engine.state(1).every(s=>s.status==='scanning'&&s.gap_from<=base));
});
test('Cancellation ignores late history and does not erase an unfinished checkpoint',async t=>{
 const f=fixture(t);f.seed();f.connect();f.engine.disconnect(1);assert.ok(f.engine.state(1).every(s=>s.status==='interrupted'));assert.equal(f.engine.page(1,0,[event('1',base)]),false);assert.equal(f.saved.size,0);
 f.db.prepare("UPDATE zalo_recovery SET status='scanning'").run();const repaired=zaloRecovery({db:f.db,ingest:()=>false});assert.ok(repaired.state(1).every(s=>s.status==='interrupted'));repaired.close();
 f.setTime(base+day*3);f.connect();assert.ok(f.engine.state(1).every(s=>s.gap_from===base-120000));assert.throws(()=>f.engine.retry(1),/Đang rà/);
});
