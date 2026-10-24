import {test} from 'node:test';
import assert from 'node:assert/strict';
import {messageLayout,sameMessageGroup} from './public/message-layout.js';
const m=(created,extra={})=>({kind:'incoming',author_id:'customer-1',created,...extra});
test('Nearby messages share one time and author, with separate calendar dates',()=>{
 const items=[m('2026-10-24T10:00:00'),m('2026-10-24T10:01:00'),m('2026-10-24T10:02:00'),m('2026-10-25T10:02:00')];
 const layout=messageLayout(items);
 assert.deepEqual(layout.map(x=>x.newDay),[true,false,false,true]);
 assert.deepEqual(layout.map(x=>x.continued),[false,true,true,false]);
 assert.deepEqual(layout.map(x=>x.showTime),[false,false,true,true]);
});
test('Different group members, staff, direction, long gaps and notes start a new group',()=>{
 const first=m('2026-10-24T10:00:00');
 for(const next of [m('2026-10-24T10:01:00',{author_id:'customer-2'}),m('2026-10-24T10:01:00',{kind:'outgoing'}),m('2026-10-24T10:05:00'),m('2026-10-24T09:59:00'),m('2026-10-24T10:01:00',{kind:'note'}),m('invalid')])assert.equal(sameMessageGroup(first,next),false);
 assert.equal(sameMessageGroup(m('2026-10-24T23:59:00'),m('2026-10-25T00:00:00')),false);
 assert.equal(sameMessageGroup(m('2026-10-24T10:00:00',{kind:'outgoing',author_id:null,sender_name:'An'}),m('2026-10-24T10:01:00',{kind:'outgoing',author_id:null,sender_name:'Bình'})),false);
});
