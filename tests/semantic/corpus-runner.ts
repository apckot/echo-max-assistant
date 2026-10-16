import {evaluateObservation,observationSchema,type Audit,type CorpusCase,type Observation} from './oracle.js';
export interface CollectedCase {readonly case:CorpusCase;readonly status:Observation['status']|'collector_error';readonly audit:Audit;readonly observation:Observation|null}
/** No model, media, fixture/control file or network imports. A collector failure cannot become an empty success. */
export async function runCorpus(cases:readonly CorpusCase[],collect:(c:CorpusCase)=>Promise<unknown>):Promise<readonly CollectedCase[]>{
 if(new Set(cases.map(c=>c.id)).size!==cases.length)throw Error('CORPUS_DUPLICATE_IDS');
 const rows:CollectedCase[]=[];
 for(const c of cases){try{const value=observationSchema.parse(await collect(c));rows.push({case:c,status:value.status,audit:evaluateObservation(c,value),observation:value});}catch{rows.push({case:c,status:'collector_error',audit:evaluateObservation(c,null),observation:null});}}
 return rows;
}
/** Eval-only decorators observe application ports and transport entries; they never invoke a provider themselves. */
export class EvalSampler{
 private semantic=0;private semanticWire=0;private stt=0;private sttWire=0;private portMs=0;
 constructor(private readonly now:()=>number=()=>performance.now()){}
 async port<T>(kind:'semantic'|'stt',work:()=>Promise<T>):Promise<T>{this[kind]++;const start=this.now();try{return await work();}finally{this.portMs+=Math.max(0,this.now()-start);}}
 async wire<T>(kind:'semantic'|'stt',work:()=>Promise<T>):Promise<T>{if(kind==='semantic')this.semanticWire++;else this.sttWire++;return work();}
 snapshot(){return {semantic:this.semantic,semanticWire:this.semanticWire,stt:this.stt,sttWire:this.sttWire,portMs:this.portMs};}
}
