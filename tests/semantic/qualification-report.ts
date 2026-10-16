import type {CollectedCase} from './corpus-runner.js';
const percentile=(values:readonly number[])=>{const sorted=[...values].sort((a,b)=>a-b);return {n:sorted.length,p95:sorted.length?sorted[Math.ceil(sorted.length*.95)-1]!:null};};
export function qualificationReport(rows:readonly CollectedCase[],control?:{ids:readonly string[];frozen:boolean;unusedForTuning:boolean}){
 const modes={R:0,V:0,F:0,P:0},categories={task:0,query:0,negative:0,choice:0,unsupported:0,denied:0,callback:0};
 for(const row of rows){modes[row.case.mode]++;categories[row.case.category]++;}
 const eligible=rows.filter(r=>r.case.mode==='R'&&r.case.execution==='real'&&r.case.set==='regression'&&['task','query'].includes(r.case.category));
 const h=rows.filter(r=>r.case.set==='control');
 const independentControl=!!control&&control.frozen&&control.unusedForTuning&&control.ids.length===20&&new Set(control.ids).size===20&&h.length===20&&h.every(r=>control.ids.includes(r.case.id)&&r.case.execution==='real'&&r.case.mode==='R'&&r.observation!==null);
 const totals=eligible.reduce((a,r)=>({tp:a.tp+r.audit.truePositive,fp:a.fp+r.audit.falsePositive,fn:a.fn+r.audit.falseNegative}),{tp:0,fp:0,fn:0});
 const precision=totals.tp+totals.fp?totals.tp/(totals.tp+totals.fp):null,recall=totals.tp+totals.fn?totals.tp/(totals.tp+totals.fn):null;
 const families=Object.fromEntries([...new Set(rows.map(r=>r.case.family))].map(f=>{const sample=eligible.filter(r=>r.case.family===f);return [f,{eligible:sample.length,exact:sample.filter(r=>r.audit.exact).length}];}));
 const latencies=(filter:(r:CollectedCase)=>boolean)=>rows.filter(filter).flatMap(r=>r.observation?[r.observation.latencyMs]:[]);
 return {total:rows.length,modes,categories,errors:rows.filter(r=>['error','collector_error'].includes(r.status)).length,collectorErrors:rows.filter(r=>r.status==='collector_error').length,modelEligible:eligible.length,modelExact:eligible.filter(r=>r.audit.exact).length,families,precision,recall,independentControl,
  qualityQualified:eligible.length>0&&independentControl&&eligible.filter(r=>r.audit.exact).length/eligible.length>=.9&&precision!==null&&precision>=.98&&recall!==null&&recall>=.95&&rows.every(r=>r.audit.safety&&(!r.case.critical||r.audit.exact))&&h.filter(r=>r.audit.exact).length>=18&&['create','update','lifecycle','query','multi'].every(f=>!!families[f]&&families[f]!.eligible>0&&families[f]!.exact/families[f]!.eligible>=.9),
  allLatency:percentile(latencies(()=>true)),successLatency:percentile(latencies(r=>r.status==='completed'&&r.audit.exact)),standardVoiceLatency:percentile(latencies(r=>r.case.clipMs!==undefined&&r.case.clipMs<=120000)),longVoiceLatency:percentile(latencies(r=>r.case.clipMs!==undefined&&r.case.clipMs>120000)),queueLatency:percentile(rows.flatMap(r=>r.observation?[r.observation.queueMs]:[])),
  calls:rows.reduce((a,r)=>({semantic:a.semantic+(r.observation?.semantic??0),semanticWire:a.semanticWire+(r.observation?.semanticWire??0),stt:a.stt+(r.observation?.stt??0),sttWire:a.sttWire+(r.observation?.sttWire??0),unknown:a.unknown+(r.observation?0:1)}),{semantic:0,semanticWire:0,stt:0,sttWire:0,unknown:0}),
  knownCostUsd:rows.reduce((n,r)=>n+(r.observation?.costUsd??0),0),unknownCost:rows.filter(r=>!r.observation||r.observation.costUsd===null).length};
}
