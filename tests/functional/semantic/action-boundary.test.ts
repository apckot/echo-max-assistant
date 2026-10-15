import {expect,test} from 'vitest';
import {frame} from '../../support/semantic-frame.js';
import {validateDecision} from '../../../src/modules/semantic/application/decision-validator.js';
import third from '../../../docs/progress/stage-3-openai-probe-attempt-3-results.json';
import {parseMeaningDraft} from '../../../src/modules/semantic/domain/meaning-decision.js';
import {preparePrivacy} from '../../../src/modules/privacy/application/privacy-gateway.js';
import {groundMeaningDraft} from '../../../src/modules/semantic/application/quote-grounding.js';
import {probeCases} from '../../semantic/stage3-probe.js';
test('source evidence/ownership/polarity and command intent remain authoritative',()=>{
 expect(validateDecision(frame('Купи молоко').grounded,'S1').groups[0]?.status).toBe('ready');
 for(const text of ['Не создавай задачу купить молоко','Перенеси звонок на завтра','Он сказал: «Купи молоко»'])expect(validateDecision(frame(text).grounded,'S1').groups[0]?.status).toBe('blocked');
 const g=frame('Купи молоко').grounded;const poisoned=structuredClone(g);poisoned.decision.units[0]!.authoredByOwner=false;expect(validateDecision(poisoned,'S1').groups[0]?.status).toBe('blocked');
 poisoned.decision.units[0]!.evidence[0]!.start=1;expect(()=>validateDecision(poisoned,'S1')).toThrow('DECISION_EVIDENCE');
});
test('quote completion creates a copy; model cannot promote quoted/negated lifecycle to mutation',()=>{
 const g=frame('Создай задачу «Я сделал отчёт»','complete').grounded;expect(validateDecision(g,'S1').groups[0]?.status).toBe('blocked');
 const positive=frame('Заверши задачу «Не забыть молоко»','complete').grounded;expect(validateDecision(positive,'S1').groups[0]?.status).toBe('ready');
 const negative=frame('Не заверши задачу «Не забыть молоко»','complete').grounded;expect(validateDecision(negative,'S1').groups[0]?.status).toBe('blocked');
});
test('C016/C034 retain independent actions and exact date-only update; wrong deadline stays blocked',()=>{
 for(const id of ['C016','C034']){
  const c=probeCases().find(c=>c.id===id)!;const privacy=preparePrivacy(c.pack,{externalAllowed:true});if(privacy.route==='denied')throw Error('privacy');
  const d=parseMeaningDraft(third.results.find(r=>r.id===id)!.result.decision);const g=groundMeaningDraft(d,privacy.sourceMap);
  const result=validateDecision(g,c.pack.sourceLabel);expect(result.groups).toHaveLength(2);expect(result.groups.every(gr=>gr.status!=='blocked')).toBe(true);
  const before=JSON.stringify(g);const poisoned=structuredClone(g);poisoned.decision.actions.find(a=>a.kind==='update')!.times[0]!.field='deadline';
  const check=validateDecision(poisoned,c.pack.sourceLabel);expect(check.groups.filter(gr=>gr.status==='blocked')).toHaveLength(1);expect(JSON.stringify(g)).toBe(before);
 }
});
test('created references cannot cycle; connected groups merge, independent ambiguity remains local',()=>{
 const g=frame('Купи молоко').grounded;const a=g.decision.actions[0]!;const u=g.decision.units[0]!;
 const d=structuredClone(g);d.decision.units.push({...u,label:'u2'});d.decision.actions.push({...a,label:'a2',unitLabel:'u2',kind:'complete',fields:{title:null,description:null,clearFields:[]},target:{kind:'created',label:'a1'}});d.decision.groups.push({label:'g2',unitLabels:['u2'],actionLabels:['a2'],queryLabels:[],outcome:'execute',reason:null});
 expect(validateDecision(d,'S1').groups).toHaveLength(1);
 d.decision.actions[0]!.target={kind:'created',label:'a2'};expect(()=>validateDecision(d,'S1')).toThrow('DECISION_GRAPH');
});
test('mutation kinds cannot substitute each other or use a clipped affirmative quote after negation',()=>{
 for(const kind of ['complete','cancel','reopen'])expect(validateDecision(frame('Перенеси звонок на завтра',kind).grounded,'S1').groups[0]?.status).toBe('blocked');
 const g=frame('Не надо завершать звонок','complete').grounded;const evidence=g.decision.actions[0]!.evidence[0]!;evidence.quote='завершать звонок';evidence.start=8;g.decision.units[0]!.evidence=[evidence];
 expect(validateDecision(g,'S1').groups[0]?.status).toBe('blocked');
});
test('resolved C034 creates the purchase independently and preserves dated relocation draft for target choice',async()=>{
 const {resolveDecision}=await import('../../../src/modules/semantic/application/decision-validator.js');
 const {TargetResolver}=await import('../../../src/modules/semantic/application/target-resolver.js');
 const {TemporalNormalizer}=await import('../../../src/modules/semantic/application/temporal-normalizer.js');
 const {IanaTimeResolver}=await import('../../../src/infrastructure/time/iana-time-resolver.js');
 const c=probeCases().find(c=>c.id==='C034')!,p=preparePrivacy(c.pack,{externalAllowed:true});if(p.route==='denied')throw Error('privacy');
 const grounded=groundMeaningDraft(parseMeaningDraft(third.results.find(r=>r.id==='C034')!.result.decision),p.sourceMap);
 const snapshot={bindings:{},anchors:[]};const resolver=new TargetResolver(snapshot,async()=>[{id:'call1',version:1},{id:'call2',version:2}]);
 const groups=await resolveDecision(validateDecision(grounded,c.pack.sourceLabel),resolver,new TemporalNormalizer(new IanaTimeResolver()),c.pack);
 expect(groups.map(g=>g.status)).toEqual(['ready','choice']);const move=groups[1]!.actions[0]!;
 expect(move.time).toEqual({status:'resolved',values:[{field:'targetDate',date:'2026-09-12'}]});expect(move.draft.fields).toEqual({title:null,description:null,clearFields:[]});expect(move.target).toMatchObject({status:'choice'});
});
test('completion artifacts, trailing retraction and same-target split groups cannot escape the boundary',()=>{
 expect(validateDecision(frame('Отчёт сделан').grounded,'S1').groups[0]?.status).toBe('blocked');
 const g=frame('Позвонить завтра. Нет, это я цитирую старое сообщение, ничего не сохраняй').grounded;
 expect(validateDecision(g,'S1').groups[0]?.status).toBe('blocked');
 const d=frame('Перенеси звонок на завтра','update',{field:'targetDate',expression:'на завтра'}).grounded;
 const action=d.decision.actions[0]!,unit=d.decision.units[0]!;
 d.decision.units.push({...unit,label:'u2'});d.decision.actions.push({...action,label:'a2',unitLabel:'u2',kind:'cancel',times:[]});d.decision.groups.push({label:'g2',unitLabels:['u2'],actionLabels:['a2'],queryLabels:[],outcome:'execute',reason:null});
 expect(validateDecision(d,'S1').groups).toHaveLength(1);
});
test('review: negative purchases and fabricated search qualifiers cannot acquire authority',()=>{
 for(const text of ['Не купи молоко','Не покупай молоко'])expect(validateDecision(frame(text).grounded,'S1').groups[0]?.status).toBe('blocked');
 const g=frame('Заверши молоко','complete').grounded;g.decision.actions[0]!.target={kind:'search',title:'Отчёт',qualifiers:{date:null,status:null},evidence:g.decision.actions[0]!.evidence};
 expect(validateDecision(g,'S1').groups[0]?.status).toBe('blocked');
});
test('review: date-only update cannot rename or rewrite description',()=>{
 for(const key of ['title','description'] as const){const g=frame('Перенеси звонок на завтра','update',{field:'targetDate',expression:'на завтра'}).grounded;g.decision.actions[0]!.fields[key]='Договор';expect(validateDecision(g,'S1').groups[0]?.status).toBe('blocked');}
});
test('review: shared-time lifecycle error blocks its component, not an unrelated create',()=>{
 const g=frame('Купи молоко').grounded,a=g.decision.actions[0]!,u=g.decision.units[0]!;
 for(const n of [2,3]){g.decision.units.push({...u,label:'u'+n});g.decision.actions.push({...a,label:'a'+n,unitLabel:'u'+n});g.decision.groups.push({label:'g'+n,unitLabels:['u'+n],actionLabels:['a'+n],queryLabels:[],outcome:'execute',reason:null});}
 g.decision.actions[0]!.kind='complete';g.decision.actions[0]!.target={kind:'candidate',label:'T1',evidence:a.evidence};
 g.decision.relations=[{kind:'shared_time',fromLabel:'u1',toLabels:['u2'],evidence:u.evidence}];
 const result=validateDecision(g,'S1');expect(result.groups).toHaveLength(2);expect(result.groups.find(gr=>gr.labels.includes('g3'))?.status).toBe('ready');
});
test('C028 review target date is proven from source calendar, never a destination filter',async()=>{
 const {TemporalNormalizer}=await import('../../../src/modules/semantic/application/temporal-normalizer.js');const {IanaTimeResolver}=await import('../../../src/infrastructure/time/iana-time-resolver.js');
 const f=frame('Заверши договор за10 сентября','complete');f.grounded.decision.actions[0]!.target={kind:'search',title:'договор',qualifiers:{date:'2026-09-10',status:null},evidence:f.grounded.decision.actions[0]!.evidence};
 const options={source:f.source,time:new TemporalNormalizer(new IanaTimeResolver())};expect(validateDecision(f.grounded,'S1',options).groups[0]?.status).toBe('ready');
 const target=f.grounded.decision.actions[0]!.target;if(target.kind==='search')target.qualifiers.date='2026-09-09';expect(validateDecision(f.grounded,'S1',options).groups[0]?.status).toBe('blocked');
});
test('review: each cleared field and ordinal is source-proven, destination day is not a list index',()=>{
 const f=frame('Убери дату списка у звонка','update');f.grounded.decision.actions[0]!.fields.clearFields=['scheduledAt'];expect(validateDecision(f.grounded,'S1').groups[0]?.status).toBe('blocked');
 const g=frame('Второе перенеси на 1 октября','update',{field:'targetDate',expression:'на 1 октября'}).grounded;g.decision.actions[0]!.target={kind:'list_index',anchorLabel:'L1',indices:[1],evidence:g.decision.actions[0]!.evidence};expect(validateDecision(g,'S1').groups[0]?.status).toBe('blocked');
});
