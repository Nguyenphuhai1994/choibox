import {test} from 'node:test';
import assert from 'node:assert/strict';
import {channelStatus} from './channel-status.mjs';
test('stream indicators use runtime state rather than a persisted verified flag',()=>{
 const ch={provider:'facebook_personal',mode:'live',enabled:1,secret:'configured',verified:1};
 assert.equal(channelStatus(ch).state,'disconnected');
 assert.equal(channelStatus(ch,{runtime:{connected:true,encrypted:true}}).state,'connected');
 assert.equal(channelStatus(ch,{runtime:{connected:true,encrypted:false}}).state,'partial');
 assert.equal(channelStatus(ch,{runtime:{connected:false,encrypted:false,connecting:true}}).state,'connecting');
 assert.equal(channelStatus({...ch,enabled:0},{runtime:{connected:true,encrypted:true}}).state,'paused');
 assert.equal(channelStatus({...ch,provider:'zalo_personal'},{runtime:{connected:true}}).state,'connected');
});
test('Page/OA stale verification cannot falsely show a live connection',()=>{
 const ch={provider:'facebook',mode:'live',enabled:1,secret:'configured',verified:1,last_checked:new Date(1000000).toISOString()};
 assert.equal(channelStatus(ch,{now:1000001}).state,'connected');
 assert.equal(channelStatus(ch,{now:1000000+11*60000}).state,'unverified');
 assert.equal(channelStatus({...ch,verified:0},{now:1000001}).state,'disconnected');
 assert.equal(channelStatus({...ch,mode:'demo'},{now:1000001}).state,'demo');
});
