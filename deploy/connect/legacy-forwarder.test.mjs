import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createLegacyForwarder} from './legacy-forwarder.mjs';
const cloudflareUrl='https://choibox-connect.https-pancake-vn-features-https-pancake.workers.dev';
function fixture({version='1.5.0',upgradeAfterPost=false,localFails=false,desktopFails=false,healthFails=false}={}){
 const calls=[],acks=[];let posted=false;
 const bridge=createLegacyForwarder({activation:{token:'a'.repeat(48)},appSecret:'test-secret',cloudflareUrl,transport:async(url,options={})=>{
  calls.push(url);
  if(url.endsWith('/api/health')){if(healthFails)throw Error('Desktop off');return {app:'Choibox',version:upgradeAfterPost&&posted?'1.6.0':version};}
  if(url.endsWith('/v1/events')){if(localFails&&url.startsWith('http:'))throw Error('Unavailable');assert.equal(options.headers.Authorization,'Bearer '+'a'.repeat(48));return {events:[{id:url.startsWith('http:')?1:2,entry:{id:'111',changes:[]}}]};}
  if(url.endsWith('/webhooks/facebook')){if(desktopFails)throw Error('Unavailable');assert.equal(options.headers['x-hub-signature-256'],'sha256='+createHmac('sha256','test-secret').update(options.body).digest('hex'));posted=true;return {ok:true};}
  if(url.endsWith('/ack')){acks.push({url,ids:JSON.parse(options.body).ids});return {ok:true};}
  throw Error('Unexpected URL');
 }});
 return {...bridge,calls,acks};
}
test('Legacy bridge drains only owner queues, survives old gateway failure and signs the local delivery',async()=>{
 const f=fixture({localFails:true});await f.poll();
 assert.deepEqual(f.acks,[{url:cloudflareUrl+'/v1/events/ack',ids:[2]}]);
 const unavailable=fixture({desktopFails:true});await unavailable.poll();assert.equal(unavailable.acks.length,0);
 const off=fixture({healthFails:true});await off.poll();assert.equal(off.acks.length,0);assert.equal(off.calls.length,1);
});
test('Legacy bridge leaves queues untouched for an upgraded desktop, including an upgrade during delivery',async()=>{
 const newer=fixture({version:'1.6.0'});await newer.poll();assert.equal(newer.calls.length,1);assert.equal(newer.acks.length,0);
 const upgrading=fixture({upgradeAfterPost:true});await upgrading.poll();assert.equal(upgrading.acks.length,0);
 assert.throws(()=>createLegacyForwarder({activation:{token:'a'.repeat(48)},appSecret:'test-secret',cloudflareUrl:'https://other.example'}));
});
