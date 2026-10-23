import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {customerProfiles,providerFailure} from './customer-profile.mjs';
import {profileLink} from './workspace-features.mjs';
function setup(t,transport){const db=new DatabaseSync(':memory:');db.exec(`CREATE TABLE channels(id INTEGER PRIMARY KEY,external_id TEXT,provider TEXT,mode TEXT,enabled INTEGER,secret TEXT);
CREATE TABLE conversations(id INTEGER PRIMARY KEY,channel_id INTEGER,external_id TEXT,kind TEXT,comment_id TEXT,contact_id TEXT,name TEXT,version INTEGER DEFAULT 1);
CREATE TABLE customer_profiles(conversation_id INTEGER PRIMARY KEY,avatar BLOB,avatar_type TEXT,profile_url TEXT DEFAULT '',phone TEXT,address TEXT,checked INTEGER DEFAULT 0);
INSERT INTO channels VALUES(1,'111','facebook','live',1,'secret');
INSERT INTO conversations(id,channel_id,external_id,kind,name) VALUES(1,1,'222','chat','Customer');`);t.after(()=>db.close());const calls=[],images=[];const service=customerProfiles({db,decrypt:()=>({access_token:'PRIVATE_TOKEN',graph_version:'v25.0'}),transport:async(url,options)=>{assert.equal(options.headers.Authorization,'Bearer PRIVATE_TOKEN');const u=new URL(url);calls.push(u);return transport(u);},avatarBytes:async url=>{images.push(url);return {data:Buffer.from('real-image-bytes'),mime:'image/jpeg'};},profileLink});return {db,calls,images,service,c:db.prepare('SELECT * FROM conversations').get()};}
test('Messenger avatar and returned profile link sync automatically and separately',async t=>{
const f=setup(t,u=>u.searchParams.get('fields')==='link'?{id:'222',link:'https://www.facebook.com/real.user'}:{id:'222',first_name:'Real',last_name:'User',profile_pic:'https://x.fbcdn.net/picture.jpg'});
await f.service.profile(f.c);const s=f.service.publicState(1);assert.equal(s.has_avatar,1);assert.equal(s.profile_url,'https://www.facebook.com/real.user');assert.equal(s.profile_status,'ready');assert.equal(f.images.length,1);assert.equal(f.db.prepare('SELECT name FROM conversations').get().name,'Real User');await f.service.profile(f.c);assert.equal(f.calls.length,2);
});
test('An unsupported link field cannot discard a successful avatar',async t=>{
const f=setup(t,u=>{if(u.searchParams.get('fields')==='link')throw providerFailure({error:{code:100,message:'Unsupported field link'}},400);return {id:'222',profile_pic:'https://x.fbcdn.net/picture.jpg'};});await f.service.profile(f.c);assert.equal(f.service.publicState(1).has_avatar,1);assert.equal(f.service.publicState(1).profile_status,'ready');assert.equal(f.service.publicState(1).profile_url,'');
});
test('Picture edge is used if profile_pic lookup is denied',async t=>{
const f=setup(t,u=>{if(u.pathname.endsWith('/picture'))return {data:{url:'https://x.fbcdn.net/real.jpg',is_silhouette:false}};throw providerFailure({error:{code:100,error_subcode:33,message:'Not accessible'}},400);});await f.service.profile(f.c);assert.equal(f.service.publicState(1).has_avatar,1);assert.ok(f.calls.some(u=>u.pathname.endsWith('/picture')&&u.searchParams.get('redirect')==='false'));
});
test('Old comment author is backfilled from the root comment before picture lookup',async t=>{
const f=setup(t,u=>{if(u.pathname.endsWith('/111_999'))return {from:{id:'333',name:'Comment Author'}};if(u.pathname.endsWith('/333/picture'))return {data:{url:'https://x.fbcdn.net/author.jpg',is_silhouette:false}};if(u.pathname.endsWith('/333'))return {id:'333',link:'https://www.facebook.com/actual.author'};throw Error('Unexpected path');});f.db.prepare("UPDATE conversations SET kind='comment',external_id='comment:111_999',comment_id='111_999',contact_id=NULL WHERE id=1").run();await f.service.profile(f.db.prepare('SELECT * FROM conversations').get());assert.equal(f.db.prepare('SELECT contact_id FROM conversations').get().contact_id,'333');assert.equal(f.service.publicState(1).profile_url,'https://www.facebook.com/actual.author');assert.equal(f.service.publicState(1).has_avatar,1);assert.ok(f.calls.every(u=>!u.pathname.includes('comment:')));
});
test('Missing Page permissions are explicit and retries recover instead of one-hour silent failure',async t=>{
let broken=true;const f=setup(t,()=>{if(broken)throw providerFailure({error:{code:190,message:'Any of the pages_messaging permission(s) must be granted before impersonating a user page PRIVATE_TOKEN'}},400);return {id:'222',profile_pic:'https://x.fbcdn.net/real.jpg'};});await f.service.profile(f.c);const s=f.service.publicState(1);assert.equal(s.profile_reason,'page_permissions');assert.equal(s.profile_code,190);assert.ok(s.profile_message.includes('kết nối lại'));assert.ok(!JSON.stringify(s).includes('PRIVATE_TOKEN'));const n=f.calls.length;await f.service.profile(f.c);assert.equal(f.calls.length,n);broken=false;f.db.prepare('UPDATE customer_profiles SET checked=0 WHERE conversation_id=1').run();await f.service.profile(f.c,{force:true});assert.equal(f.service.publicState(1).has_avatar,1);
});
test('Historical failed cache is retried immediately after the migration',async t=>{
const f=setup(t,()=>({id:'222',profile_pic:'https://x.fbcdn.net/real.jpg'}));f.db.prepare("INSERT INTO customer_profiles(conversation_id,checked) VALUES(1,?)").run(Date.now());await f.service.profile(f.c);assert.equal(f.service.publicState(1).has_avatar,1);
});
test('Page-scoped ID never becomes a guessed public Facebook link',async t=>{
const f=setup(t,()=>({id:'222',first_name:'Scoped'}));await f.service.profile(f.c);assert.equal(f.service.publicState(1).profile_url,'');assert.equal(f.images.length,0);
});
test('Wrong subject or silhouette does not replace the customer avatar',async t=>{
const f=setup(t,u=>u.pathname.endsWith('/picture')?{data:{url:'https://x.fbcdn.net/default.jpg',is_silhouette:true}}:{id:'999',first_name:'Wrong',profile_pic:'https://x.fbcdn.net/wrong.jpg',link:'https://www.facebook.com/wrong'});await f.service.profile(f.c);assert.equal(f.images.length,0);assert.equal(f.service.publicState(1).has_avatar,0);assert.equal(f.service.publicState(1).profile_url,'');assert.equal(f.db.prepare('SELECT name FROM conversations').get().name,'Customer');
});
test('Provider errors preserve only safe codes and classified reasons',()=>{const e=providerFailure({error:{code:100,error_subcode:33,message:'Unsupported get request PRIVATE_TOKEN'}},400);assert.equal(e.providerReason,'profile_unavailable');assert.equal(e.providerSubcode,33);assert.ok(!JSON.stringify(e).includes('PRIVATE_TOKEN'));assert.ok(!e.message.includes('PRIVATE_TOKEN'));});
test('Automatic profile links refresh; manually supplied links remain authoritative',async t=>{
let link='https://www.facebook.com/old.username';const f=setup(t,u=>u.searchParams.get('fields')==='link'?{id:'222',link}:{id:'222',profile_pic:'https://x.fbcdn.net/picture.jpg'});await f.service.profile(f.c);assert.equal(f.service.publicState(1).profile_url,link);link='https://www.facebook.com/new.username';f.db.prepare('UPDATE customer_profiles SET checked=0,retry_at=0').run();await f.service.profile(f.c);assert.equal(f.service.publicState(1).profile_url,link);f.db.prepare("UPDATE customer_profiles SET checked=0,retry_at=0,link_source='manual',profile_url='https://www.facebook.com/manual'").run();await f.service.profile(f.c);assert.equal(f.service.publicState(1).profile_url,'https://www.facebook.com/manual');
});
