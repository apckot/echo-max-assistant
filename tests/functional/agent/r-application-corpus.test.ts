import {beforeAll,afterAll,test,expect} from 'vitest';
import {writeFileSync} from 'node:fs';
import {agentFixture} from '../../support/agent-fixture.js';
import {rFixtures} from '../../semantic/r-fixtures.js';
import {collectApplication} from '../../semantic/application-collector.js';
let f:Awaited<ReturnType<typeof agentFixture>>;
beforeAll(async()=>{f=await agentFixture();},120000);afterAll(async()=>{await f?.close();});
test('all78 trusted typed mechanism proposals are measured from actual Tasks/history/receipts/outbox, never model-quality evidence',async()=>{
 const {collectRCorpus}=await import('../../semantic/r-application-runner.js');const result=await collectRCorpus(f);expect(result.rows).toHaveLength(78);for(const r of result.rows)expect.soft(r.audit.exact,r.case.id+':'+JSON.stringify(r.audit)).toBe(true);expect(result.qualification.qualityQualified).toBe(false);expect(result.qualification.modelEligible).toBe(0);
 if(process.env.ECHO_R_CORPUS_REPORT)writeFileSync(process.env.ECHO_R_CORPUS_REPORT,JSON.stringify(result,null,2)+'\n');
},120000);
test('collector detects wrong date, renamed preserved field and extra action in actual committed results',async()=>{
 for(const mode of ['date','title','extra']){const original=rFixtures.find(c=>c.id==='C016')!,c=structuredClone(original);
 if(mode==='date')(c.proposal.groups[1]!.effects[0] as any).patch.targetDate='2026-09-13';
 if(mode==='title')(c.proposal.groups[1]!.effects[0] as any).patch.title='Неверное имя';
 if(mode==='extra')c.proposal.groups.push({status:'ready',effects:[{kind:'create',ref:'N8',fields:{title:'Лишнее',description:null,status:'open',targetDate:null,scheduledAt:null,dueDate:null,dueAt:null,timezone:'Europe/Moscow',version:1}}]});
 expect((await collectApplication(f,c)).audit.exact).toBe(false);}
},120000);
test('same collector can enter the full provider/coordinator path; a wrong semantic date is not repaired',async()=>{
 const {frame}=await import('../../support/semantic-frame.js');const {projectLegacyQuotes}=await import('../../support/semantic-replay.js');const {parseMeaningDraft}=await import('../../../src/modules/semantic/domain/meaning-decision.js');
 const c=rFixtures.find(c=>c.id==='C002')!;
 for(const wrong of [false,true]){const base=parseMeaningDraft(projectLegacyQuotes(frame(c.input.text).grounded.decision));const decision=parseMeaningDraft({...base,actions:base.actions.map(a=>({...a,fields:{...a.fields,title:'Купить молоко'},...(wrong?{times:[{field:'targetDate',expression:'завтра',evidence:[{sourceLabel:'S1',quote:'завтра'}],scopeUnitLabels:[a.unitLabel]}]}:{})}))});
 let calls=0;const r=await collectApplication(f,c,{kind:'provider',provider:{decide:async()=>{calls++;return {outcome:'ok',decision,model:'fake',durationMs:1,usage:null};}}});expect(calls).toBe(1);expect(r.audit.exact).toBe(!wrong);expect(r.case.execution).toBe('fake');expect(r.externalCalls).toBe(0);}
},120000);
test('returned C095 row fields and outcome claims are independently checked',async()=>{
 const {observedQuery,outcomeWordingMatches,materializedCase}=await import('../../semantic/application-collector.js');
 const r=await collectApplication(f,rFixtures.find(c=>c.id==='C095')!);expect(r.audit.exact).toBe(true);const q=structuredClone(r.queryResults[0]);const actual=q.items[0];actual.status='open';const expected=(materializedCase(rFixtures.find(c=>c.id==='C095')!).expected.unchanged as any).queries[0];expect(observedQuery(q,()=> 'T1')).not.toEqual(expected);
 const blocked=await collectApplication(f,rFixtures.find(c=>c.id==='C101')!);expect(blocked.audit.exact).toBe(true);expect(outcomeWordingMatches(blocked.groups,blocked.responseText)).toBe(true);expect(outcomeWordingMatches(blocked.groups,blocked.responseText.replace('Не удалось надёжно определить команду или цель. Это действие не выполнено.','Изменено: «Звонок».'))).toBe(false);
 for(const [group,text] of [[{outcome:'choice',receipt:null},'Нужен однозначный выбор. Это действие пока не выполнено.'],[{outcome:'rejected',receipt:{outcome:'rejected'}},'Не удалось применить эту группу действий. Задачи группы не изменены.'],[{outcome:'no_change',receipt:{outcome:'no_change',commandResults:[{kind:'update',taskId:'t',outcome:'no_change'}],snapshots:[{id:'t',title:'Тест'}]}},'Без изменений: «Тест».']] as const){expect(outcomeWordingMatches([group],text)).toBe(true);expect(outcomeWordingMatches([group],'Изменено: «Тест».')).toBe(false);}
},120000);
