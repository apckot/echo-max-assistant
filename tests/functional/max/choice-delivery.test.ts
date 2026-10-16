import {execute,taskRequest,taskHarness} from '../../support/task-command-fixtures.js';
import {test,expect} from 'vitest';
import {choiceFixture} from '../../support/choice-fixture.js';
import {createMaxSender} from '../../../src/infrastructure/max/max-client.js';
import {mapMaxUpdate} from '../../../src/infrastructure/max/update-mapper.js';
test('rich outbox stores only refs; FakeHTTP receives official inline callback buttons and no internal ids',async()=>{
 const f=await choiceFixture();try{
 expect(f.out.payload.kind).toBe('choice');expect(f.out.payload.buttons).toHaveLength(3);expect(JSON.stringify(f.out.payload)).not.toContain('c1.');let calls=0;
 const sender=createMaxSender({token:'synthetic-bot',encodeChoice:r=>f.tokens.encode(r),fetchImpl:async(_url,init)=>{calls++;const body=JSON.parse(String(init?.body));expect(body.attachments[0].type).toBe('inline_keyboard');const buttons=body.attachments[0].payload.buttons.flat();expect(buttons).toHaveLength(3);expect(buttons[1]).toMatchObject({type:'callback',payload:f.tokens.encode(f.group.choice!.options[1]!.ref)});expect(JSON.stringify(body)).not.toContain(f.group.choice!.id);return new Response(JSON.stringify({message:{body:{mid:'synthetic-sent'}}}));}});
 expect(await sender.send('301',f.out.payload)).toEqual({status:'sent',externalMessageId:'synthetic-sent'});expect(calls).toBe(1);
 }finally{await f.close();}
},120000);
test('callback binds actual message mid, not its reply link; consumption/effects/receipt/outbox are atomic and new callbackId has no second effect',async()=>{
 const f=await choiceFixture();try{
 const mid=await f.confirm(),input=await f.callback();expect((await f.processor.run(input.lease)).kind).toBe('actionable');
 expect((await f.migrator.query('SELECT state,selected FROM pending_choices')).rows).toEqual([{state:'consumed',selected:1}]);
 const rows=(await f.migrator.query('SELECT id,target_date::text AS target_date,version FROM work_items ORDER BY id')).rows;expect(rows.filter(r=>r.version===2)).toHaveLength(1);expect(rows.find(r=>r.version===2).target_date).toBe('2026-09-12');
 const counts=await f.migrator.query("SELECT (SELECT count(*) FROM work_item_events) e,(SELECT count(*) FROM task_command_receipts) r,(SELECT count(*) FROM outbound_messages) o");
 await f.processor.run((await f.callback()).lease);expect((await f.migrator.query("SELECT (SELECT count(*) FROM work_item_events) e,(SELECT count(*) FROM task_command_receipts) r,(SELECT count(*) FROM outbound_messages) o")).rows).toEqual(counts.rows);
 const mapped=mapMaxUpdate({update_type:'message_callback',timestamp:1,callback:{callback_id:'synthetic-id',timestamp:2,payload:'synthetic',user:{user_id:301,is_bot:false}},message:{recipient:{chat_id:301,chat_type:'dialog'},body:{mid},link:{type:'reply',message:{mid:'unrelated-linked-message'}}}});expect(mapped).toMatchObject({kind:'button',callbackMessageId:mid});
 }finally{await f.close();}
},120000);
test.each(['missing','wrong_message','foreign','cancel','version'])('callback %s is closed or cancel without task mutation',async mode=>{
 const f=await choiceFixture();try{
 if(mode!=='missing')await f.confirm();
 if(mode==='version')await execute(taskHarness(f),taskRequest(f.a,f.tasks.map(t=>({kind:'update',target:{taskId:t.id},expectedVersion:1,patch:{description:'Edited after choice'}}))));
 const before=(await f.migrator.query('SELECT count(*) n FROM work_item_events')).rows;
 const input=await f.callback(mode==='cancel'?0:1,mode==='wrong_message'?'other':'synthetic-choice-message',mode==='foreign'?'302':'301',mode==='foreign'?'65000':f.input.chat);
 await f.processor.run(input.lease);expect((await f.migrator.query('SELECT count(*) n FROM work_item_events')).rows).toEqual(before);
 }finally{await f.close();}
},120000);
