import {expect,test} from 'vitest';
import first from '../../../docs/progress/stage-3-openai-probe-results.json';
import {projectLegacyQuotes} from '../../support/semantic-replay.js';
import {parseMeaning} from '../../../src/modules/semantic/domain/meaning-decision.js';
import {preparePrivacy} from '../../../src/modules/privacy/application/privacy-gateway.js';
import {OpenAiDecisionProvider} from '../../../src/infrastructure/ai/openai-decision-provider.js';
import {taskRegistry} from '../../../src/modules/semantic/application/provider-port.js';
import {probeCases,auditProbe} from '../../semantic/stage3-probe.js';
const old=(id:string)=>first.results.find(r=>r.id===id)!;
const context=()=>{const p=preparePrivacy(probeCases()[0]!.pack,{externalAllowed:true});if(p.route==='denied')throw Error('unexpected');return p.context;};
test('unit/action/query/group prefixes are distinct and references retain strict validation',()=>{
 const d=structuredClone(old('C020').decision)!;expect(()=>parseMeaning(d)).toThrow();
 d.units[0]!.label='u1';d.actions[0]!.unitLabel='u1';d.groups[0]!.unitLabels=['u1'];expect(parseMeaning(d).actions[0]!.label).toBe('a1');
 expect(()=>parseMeaning({...d,units:[{...d.units[0],label:'q1'}]})).toThrow();
 expect(()=>parseMeaning({...d,actions:[{...d.actions[0],unitLabel:'a1'}]})).toThrow();
 expect(()=>parseMeaning({...d,groups:[{...d.groups[0],actionLabels:['a9']}]})).toThrow();
});
test('saved completed response with invalid labels is invalid, preserves usage and never retries',async()=>{
 let calls=0;const row=old('C020');
 const provider=new OpenAiDecisionProvider({model:'gpt-4.1-2025-04-14',apiKey:'fake',prompt:'test'},async()=>{calls++;return new Response(JSON.stringify({status:'completed',model:'gpt-4.1-2025-04-14',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(projectLegacyQuotes(row.decision))}]}],usage:{input_tokens:1988,output_tokens:217}}));});
 const result=await provider.decide(context(),taskRegistry,2,new Date(Date.now()+1000),new AbortController().signal);
 expect(result).toMatchObject({outcome:'invalid',reason:'meaning_schema',usage:{inputTokens:1988,outputTokens:217}});expect(result.durationMs).toBeGreaterThanOrEqual(0);expect(calls).toBe(1);
});
test('received malformed JSON differs from incomplete transport and exposes no raw error',async()=>{
 for(const [body,reason] of [['{bad','response_json'],[JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'bad'}]}],usage:{input_tokens:3,output_tokens:2}}),'decision_json']]){
  const provider=new OpenAiDecisionProvider({model:'x',apiKey:'fake',prompt:'test'},async()=>new Response(body));
  expect(await provider.decide(context(),taskRegistry,2,new Date(Date.now()+1000),new AbortController().signal)).toMatchObject({outcome:'invalid',reason});
 }
});
test('C034 now has tomorrow; old no-date C101 regression forbids inferred date or executing empty move',()=>{
 expect(probeCases().find(c=>c.id==='C034')!.pack.text).toBe('Купи молоко и перенеси звонок на завтра');
 const d=old('C034').decision!;expect(auditProbe('C101',{outcome:'ok',model:'x',durationMs:0,usage:null,decision:projectLegacyQuotes(d) as any})).toMatchObject({safety:true,exact:true});
 const invented=structuredClone(d);invented.actions.push({...invented.actions[0]!,label:'a2',kind:'update',times:[{field:'targetDate',expression:'завтра',scopeUnitLabels:['u2'],evidence:invented.units[1]!.evidence}]});
 expect(auditProbe('C101',{outcome:'ok',model:'x',durationMs:0,usage:null,decision:projectLegacyQuotes(invented) as any}).safety).toBe(false);
});
