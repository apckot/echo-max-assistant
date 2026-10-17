import {writeFileSync,renameSync,readFileSync,mkdirSync,appendFileSync} from 'node:fs';
import {dirname} from 'node:path';
const active=new Map<string,LoadEvidence>();
export class LoadEvidence{
 private readonly began=Date.now();private last=this.began;private readonly timer:ReturnType<typeof setInterval>;
 private state:Record<string,unknown>={status:'running',phase:'preparation',elapsedMs:0,maxHeartbeatGapMs:0};
 constructor(private readonly path?:string){if(path)mkdirSync(dirname(path),{recursive:true});this.timer=setInterval(()=>this.update({}),1000);this.update({});if(path)active.set(path,this);}
 update(patch:Record<string,unknown>){const now=Date.now(),gap=now-this.last;this.last=now;if(this.state.status==='failed'&&patch.status==='completed')delete patch.status;const previousPhase=this.state.phase;this.state={...this.state,...patch,elapsedMs:now-this.began,maxHeartbeatGapMs:Math.max(Number(this.state.maxHeartbeatGapMs),gap)};if(patch.phase&&patch.phase!==previousPhase)this.state.transitions=[...(this.state.transitions as unknown[]??[]),{phase:patch.phase,elapsedMs:now-this.began}];this.persist();}
 private persist(){if(this.path){const temporary=this.path+'.tmp';writeFileSync(temporary,JSON.stringify(this.state,null,2)+'\n',{mode:0o600});renameSync(temporary,this.path);appendFileSync(this.path+'.jsonl',JSON.stringify(this.state)+'\n',{mode:0o600});}}
 timeout(){if(!this.state.failure)this.update({status:'failed',failure:'test_timeout_or_abort',lastPhase:this.state.phase,phase:'timeout',cleanup:this.state.cleanup??'not_confirmed'});this.close();}
 close(){clearInterval(this.timer);if(this.path)active.delete(this.path);this.persist();}
}
export function markLoadTimeout(path:string){const evidence=active.get(path);if(evidence){evidence.timeout();return;}try{const last=JSON.parse(readFileSync(path,'utf8'));if(last.failure)return;writeFileSync(path,JSON.stringify({...last,status:'failed',failure:'test_timeout_or_abort',lastPhase:last.phase,phase:'timeout',cleanup:last.cleanup??'not_confirmed'},null,2)+'\n',{mode:0o600});}catch{writeFileSync(path,JSON.stringify({status:'failed',phase:'timeout',failure:'no_phase_evidence',cleanup:'not_confirmed'})+'\n',{mode:0o600});}}

export function markLoadFailure(path:string,timeout:boolean){if(timeout){markLoadTimeout(path);return;}const evidence=active.get(path);if(evidence){evidence.update({status:'failed',testFailure:'assertion_or_processing'});return;}try{const last=JSON.parse(readFileSync(path,'utf8'));writeFileSync(path,JSON.stringify({...last,status:'failed',testFailure:'assertion_or_processing'},null,2)+'\n',{mode:0o600});}catch{writeFileSync(path,JSON.stringify({status:'failed',failure:'no_phase_evidence',testFailure:'assertion_or_processing'})+'\n',{mode:0o600});}}
