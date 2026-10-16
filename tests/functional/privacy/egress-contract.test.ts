import {test,expect} from 'vitest';
import {preparePrivacy} from '../../../src/modules/privacy/application/privacy-gateway.js';
import {OpenAiDecisionProvider} from '../../../src/infrastructure/ai/openai-decision-provider.js';
import {taskRegistry} from '../../../src/modules/semantic/application/provider-port.js';
import {frame} from '../../support/semantic-frame.js';
test('entire candidate/history/pending envelope is minimized/tokenized before FakeHTTP; secrets refuse every context route',async()=>{
 const source=frame('Купи молоко').source;
 const id='00000000-0000-4000-8000-000000000001',email='synthetic@example.org';
 const pack={...source,userId:id,providerUserId:'technical-id',candidates:[{label:'T1',title:email,description:'+79990000000',status:'open' as const,targetDate:null,scheduledAt:null,deadline:null,id}],history:[{role:'user' as const,text:email}],pendingChoices:[{label:'P1',topic:id}]};
 const p=preparePrivacy(pack,{externalAllowed:true});if(p.route==='denied')throw Error('privacy');let calls=0;
 const provider=new OpenAiDecisionProvider({model:'gpt-4.1-2025-04-14',apiKey:'synthetic',prompt:'synthetic'},async(_url,request)=>{calls++;const body=String(request.body);for(const value of [id,email,'+79990000000','technical-id','providerUserId'])expect(body).not.toContain(value);expect(body).toContain('TOKEN_');return new Response('{}');});
 await provider.decide(p.context,taskRegistry,2,new Date(Date.now()+1000),new AbortController().signal);expect(calls).toBe(1);
 for(const section of ['text','candidate','history','pending']){const secret='api_key=synthetic-forbidden';const input={...pack,text:section==='text'?secret:pack.text,candidates:pack.candidates.map(c=>({...c,title:section==='candidate'?secret:c.title})),history:[{role:'user' as const,text:section==='history'?secret:email}],pendingChoices:[{label:'P1',topic:section==='pending'?secret:id}]};expect(preparePrivacy(input,{externalAllowed:true}).route).toBe('denied');}
 expect(preparePrivacy(pack,{externalAllowed:false}).route).toBe('denied');expect(preparePrivacy(pack,{externalAllowed:true,check:()=>{throw Error('synthetic classifier unavailable');}}).route).toBe('denied');
});
test('literal forged token is never a newly issued sensitive mapping',()=>{
 expect(()=>frame('Купи TOKEN_FAKE')).toThrow('UNKNOWN_PRIVACY_TOKEN');
});
