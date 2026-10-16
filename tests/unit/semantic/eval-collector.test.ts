import {test,expect} from 'vitest';
import {evaluateObservation} from '../../semantic/oracle.js';
import {runCorpus} from '../../semantic/corpus-runner.js';
import {qualificationReport} from '../../semantic/qualification-report.js';
const expected={effects:[{task:'T1',kind:'complete'},{task:'T2',kind:'update',patch:{targetDate:'2026-09-12'}}],unchanged:{'T2.title':'Звонок'},choices:[]};
const sample=(id='C016')=>({id,set:'regression' as const,mode:'R' as const,family:'multi',category:'task' as const,execution:'fake' as const,expected,critical:true});
const observation=()=>({effects:expected.effects,unchanged:expected.unchanged,choices:[],boundaries:[{name:'privacy',ok:true},{name:'apply',ok:true}],safety:{ownership:true,polarity:true,target:true,date_scope:true,committed_response:true},status:'completed' as const,semantic:1,semanticWire:1,stt:0,sttWire:0,latencyMs:120,queueMs:20,costUsd:0});
test('partial multi-action and unchanged-field drift never count full exact success',()=>{
 expect(evaluateObservation(sample(),observation())).toMatchObject({exact:true,truePositive:2,falseNegative:0});
 expect(evaluateObservation(sample(),{...observation(),effects:expected.effects.slice(0,1)})).toMatchObject({exact:false,truePositive:1,falseNegative:1});
 expect(evaluateObservation(sample(),{...observation(),unchanged:{'T2.title':'Renamed'}}).exact).toBe(false);
 expect(evaluateObservation(sample(),{...observation(),boundaries:[{name:'privacy',ok:false},{name:'apply',ok:false}]}).firstDivergence).toBe('privacy');
});
test('collector read failure stays an error with denominator, never implicit empty PASS',async()=>{
 const rows=await runCorpus([sample()],async()=>{throw Error('synthetic collector failure');});expect(rows[0]).toMatchObject({status:'collector_error',audit:{exact:false,safety:false}});const report=qualificationReport(rows);expect(report.total).toBe(1);expect(report.errors).toBe(1);expect(report.qualityQualified).toBe(false);
});
test('R/V/F/P and unsupported/denied/errors are distinct; fake runs and missing H cannot claim independent model quality',async()=>{
 const cases=[sample(),{...sample('V1'),mode:'V' as const},{...sample('F1'),mode:'F' as const},{...sample('P1'),mode:'P' as const,category:'denied' as const,deniedBefore:'semantic' as const,expected:{effects:[],unchanged:{},choices:[]}},{...sample('U1'),category:'unsupported' as const}];
 const rows=await runCorpus(cases,async c=>c.id==='P1'?{...observation(),effects:[],unchanged:{},semantic:0,semanticWire:0,status:'denied'}:observation());const report=qualificationReport(rows);expect(report.modes).toEqual({R:2,V:1,F:1,P:1});expect(report.categories.denied).toBe(1);expect(report.categories.unsupported).toBe(1);expect(report.independentControl).toBe(false);expect(report.qualityQualified).toBe(false);expect(report.modelEligible).toBe(0);
});
test('retry/repair calls, unsafe denial effects and missing safety evidence fail closed',()=>{
 for(const variant of [{semantic:2},{stt:2},{safety:{...observation().safety,target:null}},{effects:[...expected.effects,{task:'foreign',kind:'complete'}]}])expect(evaluateObservation(sample(),{...observation(),...variant}).safety).toBe(false);
 expect(evaluateObservation({...sample(),category:'denied',deniedBefore:'semantic'},observation()).safety).toBe(false);
});
test('all-turn/success-only/standard versus long voice latencies and unknown cost stay explicit',async()=>{
 const rows=await runCorpus([sample('a'),{...sample('b'),clipMs:121000},{...sample('c'),clipMs:90000}],async c=>({...observation(),latencyMs:c.id==='b'?90000:c.id==='c'?500:100,costUsd:c.id==='c'?null:0}));const report=qualificationReport(rows);expect(report.allLatency).toMatchObject({n:3,p95:90000});expect(report.standardVoiceLatency).toMatchObject({n:1,p95:500});expect(report.longVoiceLatency.n).toBe(1);expect(report.unknownCost).toBe(1);
});
test('synthetic metadata with a complete declared control still cannot qualify missing operation families',async()=>{
 const cases=[{...sample('regression'),execution:'real' as const},...Array.from({length:20},(_,i)=>({...sample('synthetic-control'+i),set:'control' as const,execution:'real' as const}))];
 const rows=await runCorpus(cases,async()=>observation());expect(qualificationReport(rows,{ids:cases.slice(1).map(c=>c.id),frozen:true,unusedForTuning:true}).qualityQualified).toBe(false);
});
test('sampler counts actual wrapped port/wire entries including failure, never model-reported invocation counts',async()=>{
 const {EvalSampler}=await import('../../semantic/corpus-runner.js');let now=10;const sampler=new EvalSampler(()=>now);
 await sampler.port('semantic',async()=>{await sampler.wire('semantic',async()=>{now+=5;return null;});return null;});
 await expect(sampler.port('stt',async()=>sampler.wire('stt',async()=>{now+=7;throw Error('synthetic');}))).rejects.toThrow('synthetic');
 expect(sampler.snapshot()).toEqual({semantic:1,semanticWire:1,stt:1,sttWire:1,portMs:12});
});

test('complete frozen regression inventory is mandatory; omitted and duplicate cases cannot qualify',async()=>{
 const regression=Array.from({length:101},(_,i)=>({...sample('C'+String(i+1).padStart(3,'0')),family:['create','update','lifecycle','query','multi'][i%5]!,execution:'real' as const}));
 const controls=Array.from({length:20},(_,i)=>({...sample('H'+i),set:'control' as const,execution:'real' as const}));
 const control={ids:controls.map(c=>c.id),frozen:true,unusedForTuning:true};
 const inventory={cases:regression,frozen:true};
 const complete=await runCorpus([...regression,...controls],async()=>observation());
 expect(qualificationReport(complete,control,inventory).qualityQualified).toBe(true);
 const reduced=complete.filter(r=>r.case.set==='control'||regression.slice(0,5).some(c=>c.id===r.case.id));
 const report=qualificationReport(reduced,control,inventory);expect(report.qualityQualified).toBe(false);expect(report.total).toBe(121);expect(report.errors).toBe(96);expect(report.modelEligible).toBe(101);expect(report.regressionComplete).toBe(false);
 expect(qualificationReport([...complete,complete[0]!],control,inventory).qualityQualified).toBe(false);
 expect(qualificationReport(complete,control).qualityQualified).toBe(false);
});
