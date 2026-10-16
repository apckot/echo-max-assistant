import {test,expect} from 'vitest';
import {EvalBudget} from '../../semantic/eval-budget.js';
import {VoicePreparation} from '../../../src/modules/media/application/transcript.js';
import {TurnCoordinator} from '../../../src/modules/agent/application/turn-coordinator.js';
test('predictive budget reserves before dispatch, duplicate/overflow/unknown usage never free capacity',()=>{
 const b=new EvalBudget(['R1','A1'],2,.1);b.reserve('R1',.04);expect(()=>b.reserve('R1',.04)).toThrow();expect(()=>b.reserve('A1',.07)).toThrow();b.reserve('A1',.06);expect(b.snapshot()).toEqual({calls:2,reservedUsd:.1});expect(()=>b.reserve('R2',0)).toThrow();
 for(const bad of [NaN,Infinity,-1])expect(()=>new EvalBudget(['x'],1,1).reserve('x',bad)).toThrow();
});
test('four coordinator slots are bounded before DB/provider work; a fifth gets busy',async()=>{
 let release!:(x:null)=>void;const hold=new Promise<null>(r=>release=r);let claims=0;
 const coordinator=new TurnCoordinator({claim:async()=>{claims++;return hold;}} as any,{} as any,{} as any,{} as any,{} as any,{profileDigest:'b'.repeat(64),externalAllowed:true,deadlineMs:7000});
 const active=Array.from({length:4},()=>coordinator.run({} as any));expect(await coordinator.run({} as any)).toEqual({status:'busy'});expect(claims).toBe(4);release(null);await Promise.all(active);
});
test('cancelled STT waiter leaves bounded queue immediately and never starts media/DB work',async()=>{
 let release!:()=>void;const hold=new Promise<void>(r=>release=r);let reads=0;
 const voice=new VoicePreparation({read:async()=>{reads++;await hold;throw Error('synthetic');},fail:async()=>{},released:async()=>{}} as any,{} as any,{} as any);
 const active=[voice.prepare({} as any),voice.prepare({} as any)],c=new AbortController();const waiting=voice.prepare({} as any,c.signal);c.abort();
 const state=await Promise.race([waiting,new Promise(r=>setTimeout(()=>r('hanging'),30))]);release();await Promise.all(active);await waiting;
 expect(state).toEqual({kind:'denied',reason:'processing_cancelled'});expect(reads).toBe(2);
});
test('load harness smoke covers two tenants, text/local-query/voice in ten actual staged operations',async()=>{
 const {stage3Load,acceptStage3Load}=await import('../../support/stage3-load.js');const r=await stage3Load();expect(acceptStage3Load(r)).toBe(true);expect(r.counts.processed).toBe(10);expect(r.failures).toBe(0);expect(r.sttCalls).toBe(3);expect(r.calls).toBeLessThanOrEqual(10);expect(r.stats.every(s=>s.maxAi<=4&&s.maxStt<=2)).toBe(true);
},120000);
test('load failure is terminal but never successful: an injected semantic refusal must fail acceptance',async()=>{
 const {stage3Load,acceptStage3Load}=await import('../../support/stage3-load.js');const r=await stage3Load(false,{failSemanticAt:1});expect(r.counts.processed).toBe(10);expect(r.failedTurns).toBe(1);expect(acceptStage3Load(r)).toBe(false);
},120000);
