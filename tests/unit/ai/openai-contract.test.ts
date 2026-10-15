import {expect,test} from 'vitest';
import {preparePrivacy,isApprovedContext,rehydrate} from '../../../src/modules/privacy/application/privacy-gateway.js';
import {OpenAiDecisionProvider} from '../../../src/infrastructure/ai/openai-decision-provider.js';
import {taskRegistry,type InternalContextPack} from '../../../src/modules/semantic/application/provider-port.js';
export const pack:InternalContextPack={text:'Позвонить Анне по +70000000000',sourceLabel:'S0',sourceAt:'2026-09-11T12:48:33Z',timezone:'Europe/Moscow',candidates:[],anchors:[],history:[],pendingChoices:[]};
const prepare=()=>preparePrivacy(pack,{externalAllowed:true,knownValues:['Анне']});
test('whole payload allowlist, known names and candidate emails are minimized with random run labels',()=>{
 const input={...pack,userId:'secret-user',candidates:[{label:'T1',title:'user@example.test',description:null,status:'open',targetDate:null,scheduledAt:null,deadline:null}]};
 const a=preparePrivacy(input as InternalContextPack,{externalAllowed:true,knownValues:['Анне']});const b=prepare();
 expect(a.route).toBe('tokenized');if(a.route==='denied'||b.route==='denied')throw Error('unexpected denial');
 const serialized=JSON.stringify(a.context);for(const forbidden of ['+70000000000','Анне','user@example.test','secret-user'])expect(serialized).not.toContain(forbidden);
 expect(serialized).not.toBe(JSON.stringify(b.context));expect(isApprovedContext(a.context)).toBe(true);
 expect(rehydrate(a.context.pack.text,a.sourceMap)).toBe(pack.text);
 expect(()=>rehydrate('TOKEN_FORGED',a.sourceMap)).toThrow();
});
test('prohibited route, known secret and failed check deny before external processing',()=>{
 expect(preparePrivacy(pack,{externalAllowed:false}).route).toBe('denied');
 expect(preparePrivacy({...pack,text:'sk-proj-abcdefghijklmnopqrstuvwxyz123456'},{externalAllowed:true}).route).toBe('denied');
 expect(preparePrivacy(pack,{externalAllowed:true,check:()=>{throw Error('private');}}).route).toBe('denied');
});
test('adapter rejects forged raw contexts, performs no retries and contains transport errors',async()=>{
 let calls=0;const provider=new OpenAiDecisionProvider({model:'gpt-4.1-2025-04-14',apiKey:'test-secret',prompt:'test'},async()=>{calls++;throw Error('test-secret');});
 const request=prepare();if(request.route==='denied')throw Error('unexpected');
 expect((await provider.decide({kind:'privacy_approved_v1',pack,route:'external_allowed'},taskRegistry,2,new Date(Date.now()+1000),new AbortController().signal)).outcome).toBe('denied');expect(calls).toBe(0);
 const result=await provider.decide(request.context,taskRegistry,2,new Date(Date.now()+1000),new AbortController().signal);
 expect(result.outcome).toBe('uncertain');expect(calls).toBe(1);expect(JSON.stringify(result)).not.toContain('test-secret');
});
test('Responses wire uses strict schema, store=false, pinned model and no raw identifiers',async()=>{
 const request=prepare();if(request.route==='denied')throw Error('unexpected');let wire:any;
 const provider=new OpenAiDecisionProvider({model:'gpt-4.1-2025-04-14',apiKey:'test-secret',prompt:'test'},async(url,init)=>{expect(url).toBe('https://api.openai.com/v1/responses');wire=JSON.parse(String(init.body));expect(init.redirect).toBe('error');return new Response(JSON.stringify({status:'completed',model:'gpt-4.1-2025-04-14',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({version:2,units:[],relations:[],actions:[],queries:[],groups:[]})}]}],usage:{input_tokens:50,output_tokens:10}}));});
 const result=await provider.decide(request.context,taskRegistry,2,new Date(Date.now()+1000),new AbortController().signal);
 expect(result.outcome).toBe('ok');expect(wire.store).toBe(false);expect(wire.text.format.strict).toBe(true);expect(wire.text.format.name).toBe('meaning_draft_v2');expect(JSON.stringify(wire.text.format.schema)).not.toContain('"start"');expect(JSON.stringify(wire.text.format.schema)).not.toContain('"end"');expect(wire.max_output_tokens).toBe(2000);expect(JSON.stringify(wire)).not.toContain('+70000000000');
});
test('full external request budget includes prompt/schema and fails locally before dispatch',async()=>{
 let calls=0;const request=prepare();if(request.route==='denied')throw Error('privacy');
 const provider=new OpenAiDecisionProvider({model:'gpt-4.1-2025-04-14',apiKey:'test-secret',prompt:'a'.repeat(24000)},async()=>{calls++;throw Error('must not dispatch');});
 expect((await provider.decide(request.context,taskRegistry,2,new Date(Date.now()+1000),new AbortController().signal)).outcome).toBe('denied');expect(calls).toBe(0);
});
