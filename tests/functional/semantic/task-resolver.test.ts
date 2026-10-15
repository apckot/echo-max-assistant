import {expect,test} from 'vitest';
import {TargetResolver} from '../../../src/modules/semantic/application/target-resolver.js';
const bindings={T1:{id:'task-one',version:2},T2:{id:'task-two',version:7}};
const snapshot={bindings,anchors:[{label:'L1',kind:'list' as const,tasks:[bindings.T2,bindings.T1]}]};
test('exact delivered list order and versions, candidate scope, no missing-reply fallback',async()=>{
 const resolver=new TargetResolver(snapshot,async()=>[]);
 expect(await resolver.resolve({kind:'list_index',anchorLabel:'L1',indices:[1],evidence:[]})).toEqual({status:'resolved',targets:[bindings.T2]});
 expect(await resolver.resolve({kind:'candidate',label:'T99',evidence:[]})).toEqual({status:'not_found'});
 expect(await resolver.resolve({kind:'reply',anchorLabel:'missing',evidence:[]})).toEqual({status:'not_found'});
});
test('0/1/2–5/>5 choices and per-component/turn postquery bounds',async()=>{
 for(const count of [0,1,2,5,6]){const resolver=new TargetResolver(snapshot,async()=>Array.from({length:count},(_,i)=>({id:'task-'+i,version:1})));const result=await resolver.resolve({kind:'search',title:'звонок',qualifiers:{date:null,status:null},evidence:[]},'component1');expect(result.status).toBe(count===0?'not_found':count===1?'resolved':count<=5?'choice':'narrow');}
 let calls=0;const resolver=new TargetResolver(snapshot,async()=>{calls++;return [];});const target={kind:'search' as const,title:'звонок',qualifiers:{date:null,status:null},evidence:[]};
 await resolver.resolve(target,'g1');await resolver.resolve(target,'g1');await resolver.resolve(target,'g2');await resolver.resolve(target,'g3');expect((await resolver.resolve(target,'g4')).status).toBe('budget');expect(calls).toBe(3);
});
