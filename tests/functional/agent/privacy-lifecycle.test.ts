import {test,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {choiceFixture} from '../../support/choice-fixture.js';
import {createDatabase} from '../../../src/infrastructure/postgres/database.js';
import {acceptMaxInbound} from '../../../src/infrastructure/postgres/postgres-intake-store.js';
test('choice cleanup is bounded/fenced and account erase removes hashes/options with no resurrection',async()=>{
 const f=await choiceFixture();try{await f.confirm();
 await expect(f.scheduler.query('SELECT * FROM pending_choices')).rejects.toThrow();
 await f.migrator.query('ALTER TABLE pending_choices DISABLE TRIGGER choice_state_guard');await f.migrator.query("UPDATE pending_choices SET expires_at=clock_timestamp()-interval '1 second'");await f.migrator.query('ALTER TABLE pending_choices ENABLE TRIGGER choice_state_guard');
 await f.migrator.query('UPDATE system_state SET restore_fence=true');await expect(f.scheduler.query('SELECT public.expire_pending_choices(10)')).rejects.toThrow();await f.migrator.query('UPDATE system_state SET restore_fence=false');expect((await f.scheduler.query('SELECT public.expire_pending_choices(10) n')).rows[0].n).toBe(1);
 const before=(await f.migrator.query('SELECT count(*) n FROM work_item_events')).rows;await f.processor.run((await f.callback()).lease);expect((await f.migrator.query('SELECT count(*) n FROM work_item_events')).rows).toEqual(before);
 const op=randomUUID(),erase=(mode:string)=>f.scheduler.query("SELECT public.erase_account($1,$2,'self_service','privacy_request',$3) result",[f.a,op,mode]);const preview=(await erase('preview')).rows[0].result;expect(preview.counts.pendingChoices).toBe(1);expect(preview.counts.choiceOptions).toBe(3);await erase('begin');await erase('finish');
 for(const table of ['pending_choices','pending_choice_options','agent_turn_keys','outbound_messages'])expect((await f.migrator.query(`SELECT count(*)::int n FROM ${table} WHERE user_id=$1`,[f.a])).rows[0].n).toBe(0);
 }finally{await f.close();}
},120000);
test('gateway persists callback token digest and dedicated source message, never raw bearer token',async()=>{
 const f=await choiceFixture(),db=createDatabase({gateway:f.gateway.options.connectionString});try{
 const token=f.tokens.encode(f.group.choice!.options[1]!.ref);const result=await acceptMaxInbound(db,{status:'normalized',kind:'button',providerUserId:'301',providerChatId:f.input.chat,providerEventKey:'callback:synthetic-hash-ingress',occurredAt:'2',callbackPayload:token,callbackMessageId:'synthetic-choice-message'},'b'.repeat(64));
 const payload=(await f.migrator.query('SELECT payload FROM inbound_events WHERE id=$1',[result.inboundEventId])).rows[0].payload;expect(payload).toEqual({kind:'button',callbackPayload:'ch1.'+f.tokens.hash(token),callbackMessageId:'synthetic-choice-message'});expect(JSON.stringify(payload)).not.toContain(token);
 }finally{await db.close();await f.close();}
},120000);
