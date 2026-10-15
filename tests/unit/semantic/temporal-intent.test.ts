import {expect,test} from 'vitest';
import second from '../../../docs/progress/stage-3-openai-probe-attempt-2-results.json';
import {preparePrivacy} from '../../../src/modules/privacy/application/privacy-gateway.js';
import {groundMeaningDraft} from '../../../src/modules/semantic/application/quote-grounding.js';
import {validateTemporalIntent} from '../../../src/modules/semantic/application/temporal-intent.js';
import {parseMeaningDraft} from '../../../src/modules/semantic/domain/meaning-decision.js';
import {probeCases,auditGroundedProbe} from '../../semantic/stage3-probe.js';
import {projectLegacyQuotes} from '../../support/semantic-replay.js';
function replay(id:string){const row=second.results.find(r=>r.id===id)!;const p=preparePrivacy(probeCases().find(c=>c.id===id)!.pack,{externalAllowed:true});if(p.route==='denied')throw Error('denied');return groundMeaningDraft(parseMeaningDraft(projectLegacyQuotes(row.localResult.decision)),p.sourceMap);}
test('exact quote grounding does not make wrong deadline/shared_time semantics acceptable',()=>{
 for(const id of ['C016','C034']){const g=replay(id),before=JSON.stringify(g.decision);const checked=validateTemporalIntent(g);
 expect(checked.ok).toBe(false);expect(checked.issues.map(x=>x.code)).toContain('TIME_INTENT_MISMATCH');expect(auditGroundedProbe(id,g).safety).toBe(false);expect(JSON.stringify(g.decision)).toBe(before);
 if(id==='C016')expect(checked.issues.map(x=>x.code)).toContain('TIME_SHARED_WITH_LIFECYCLE');
 }
 expect(validateTemporalIntent(replay('C015')).ok).toBe(true);
});
test('C016/C034 oracles check changed fields, untouched fields, exact time scope and independent groups',()=>{
 for(const id of ['C016','C034']){const g=replay(id);const fixed=structuredClone(g.decision);const move=fixed.actions.find(a=>a.kind==='update')!;
 move.times[0]!.field='targetDate';fixed.relations=[];
 if(id==='C016')fixed.groups=fixed.actions.map((a,i)=>({label:'g'+(i+1),unitLabels:[a.unitLabel],actionLabels:[a.label],queryLabels:[],outcome:'execute',reason:null}));
 const clean={...g,decision:fixed};expect(auditGroundedProbe(id,clean)).toMatchObject({safety:true,exact:true});
 const cases=[(d:any)=>{d.actions.find((a:any)=>a.kind==='update').fields.title='Wrong rename';},(d:any)=>{d.actions.find((a:any)=>a.kind==='update').fields.description='Wrong description';},(d:any)=>{const a=d.actions.find((a:any)=>a.kind==='update');a.times.push({...a.times[0],field:'scheduledAt'});},(d:any)=>{const a=d.actions.find((a:any)=>a.kind==='update');a.times.push({...a.times[0],field:'deadline'});},(d:any)=>{d.actions.find((a:any)=>a.kind==='update').fields.clearFields=['scheduledAt'];},(d:any)=>{d.actions.find((a:any)=>a.kind==='update').times[0].scopeUnitLabels=d.units.map((u:any)=>u.label);},(d:any)=>{d.groups=[{...d.groups[0],unitLabels:d.units.map((u:any)=>u.label),actionLabels:d.actions.map((a:any)=>a.label)}];},(d:any)=>{d.relations=[{kind:'depends_on',fromLabel:d.units[0].label,toLabels:[d.units[1].label],evidence:d.units[0].evidence}];}];
 for(const mutate of cases){const d=structuredClone(fixed);mutate(d);expect(auditGroundedProbe(id,{...g,decision:d}).exact).toBe(false);}
 }
});
test('date move, exact appointment time and deadline are distinct source-checked operations',()=>{
 const examples=[['Перенеси звонок на завтра','на завтра','targetDate'],['Назначь звонок завтра в девять','в девять','scheduledAt'],['Измени крайний срок отчёта на завтра','на завтра','deadline'],['Завтра к девяти отправить отчёт','к девяти','deadline']] as const;
 for(const [text,expression,expected] of examples){
  const evidence=[{sourceLabel:'S0',quote:text}];const p=preparePrivacy({...probeCases()[0]!.pack,text},{externalAllowed:true});if(p.route==='denied')throw Error('denied');
  const draft={version:2,units:[{label:'u1',kind:'action',speechAct:'request',polarity:'positive',modality:'asserted',authoredByOwner:true,evidence,uncertainty:null}],relations:[],actions:[{label:'a1',unitLabel:'u1',kind:'update',target:{kind:'candidate',label:'T1',evidence},fields:{title:null,description:null,clearFields:[]},times:[{field:expected,expression,evidence,scopeUnitLabels:['u1']}],evidence}],queries:[],groups:[{label:'g1',unitLabels:['u1'],actionLabels:['a1'],queryLabels:[],outcome:'execute',reason:null}]};
  const g=groundMeaningDraft(parseMeaningDraft(draft),p.sourceMap);expect(validateTemporalIntent(g).ok).toBe(true);
  for(const wrong of ['targetDate','scheduledAt','deadline'].filter(f=>f!==expected)){const poisoned=structuredClone(g.decision);poisoned.actions[0]!.times[0]!.field=wrong as any;const before=JSON.stringify(poisoned);expect(validateTemporalIntent({...g,decision:poisoned}).issues.map(i=>i.code)).toContain('TIME_INTENT_MISMATCH');expect(JSON.stringify(poisoned)).toBe(before);}
 }
});
