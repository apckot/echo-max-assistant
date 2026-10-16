import {test,expect} from 'vitest';
import {agentFixture} from '../../support/agent-fixture.js';
import {create,taskHarness} from '../../support/task-command-fixtures.js';
import {PostgresAgentTaskProcessing} from '../../../src/infrastructure/postgres/postgres-typed-task-processing.js';
import {GroupRunner} from '../../../src/modules/agent/application/group-runner.js';
import third from '../../../docs/progress/stage-3-openai-probe-attempt-3-results.json';
import {parseMeaningDraft} from '../../../src/modules/semantic/domain/meaning-decision.js';
test('C034 independent purchase commits while dated ambiguous relocation has no Task effect; lost ACK resumes receipts',async()=>{
 const f=await agentFixture();try{
 await create(taskHarness(f),f.a,{title:'Звонок первый'});await create(taskHarness(f),f.a,{title:'Звонок второй'});
 const input=await f.admit('Купи молоко и перенеси звонок на завтра');const saved=JSON.parse(JSON.stringify(third.results.find(r=>r.id==='C034')!.result.decision).replaceAll('S0','S1'));
 const staged=await f.coordinator({decide:async()=>({outcome:'ok',decision:parseMeaningDraft(saved),model:'fake',durationMs:1,usage:null})}).run(input.lease);if(staged.status!=='accepted')throw Error('stage');
 const lostAck=new PostgresAgentTaskProcessing({guarded:async(ticket,fn)=>{await f.authority.guarded(ticket,fn);throw Error('ACK_LOST_AFTER_COMMIT');}});
 await expect(lostAck.runGroup(staged.ticket,0)).rejects.toThrow('ACK_LOST_AFTER_COMMIT');
 expect((await f.migrator.query('SELECT count(*)::int n FROM turn_groups')).rows[0].n).toBe(1);
 const bridge=new PostgresAgentTaskProcessing(f.authority),runner=new GroupRunner(bridge);
 const outcomes=await runner.run(staged.ticket);expect(outcomes.map(x=>x.outcome)).toEqual(['applied','choice']);
 const again=await new GroupRunner(new PostgresAgentTaskProcessing(f.authority)).run(staged.ticket);expect(again).toEqual(outcomes);
 expect((await f.migrator.query('SELECT title,target_date FROM work_items ORDER BY title')).rows).toEqual([{title:'Звонок второй',target_date:null},{title:'Звонок первый',target_date:null},{title:'Купи молоко',target_date:null}]);
 expect((await f.migrator.query('SELECT count(*)::int n FROM turn_response_intents')).rows[0].n).toBe(1);
 expect((await f.migrator.query('SELECT count(*)::int n FROM outbound_messages')).rows[0].n).toBe(0);
 }finally{await f.close();}
},120000);
test('created reference is bound inside one atomic group; no-op/version planning uses Tasks rules',async()=>{
 const f=await agentFixture();try{
 const text='Купи молоко и заверши её',input=await f.admit(text);
 const evidence=(quote:string)=>[{sourceLabel:'S1',quote}];const unit=(label:string,quote:string)=>({label,kind:'action',speechAct:'request',polarity:'positive',modality:'asserted',authoredByOwner:true,evidence:evidence(quote),uncertainty:null});
 const fields={title:null,description:null,clearFields:[]};const decision=parseMeaningDraft({version:2,units:[unit('u1','Купи молоко'),unit('u2','заверши её')],actions:[{label:'a1',unitLabel:'u1',kind:'create',target:null,fields:{...fields,title:'Молоко'},times:[],evidence:evidence('Купи молоко')},{label:'a2',unitLabel:'u2',kind:'complete',target:{kind:'created',label:'a1'},fields,times:[],evidence:evidence('заверши её')}],relations:[],queries:[],groups:[{label:'g1',unitLabels:['u1'],actionLabels:['a1'],queryLabels:[],outcome:'execute',reason:null},{label:'g2',unitLabels:['u2'],actionLabels:['a2'],queryLabels:[],outcome:'execute',reason:null}]});
 const staged=await f.coordinator({decide:async()=>({outcome:'ok',decision,model:'fake',durationMs:1,usage:null})}).run(input.lease);if(staged.status!=='accepted')throw Error('stage');
 const results=await new GroupRunner(new PostgresAgentTaskProcessing(f.authority)).run(staged.ticket);expect(results).toHaveLength(1);expect(results[0]?.receipt?.commandResults.map(r=>r.afterVersion)).toEqual([1,2]);expect(results[0]?.receipt?.snapshots[0]?.status).toBe('completed');
 expect((await f.migrator.query('SELECT count(*)::int n FROM work_item_events')).rows[0].n).toBe(2);
 }finally{await f.close();}
},120000);
