import third from '../../docs/progress/stage-3-openai-probe-attempt-3-results.json';
import {probeCases} from './stage3-probe.js';
import {preparePrivacy} from '../../src/modules/privacy/application/privacy-gateway.js';
import {parseMeaningDraft} from '../../src/modules/semantic/domain/meaning-decision.js';
import {groundMeaningDraft} from '../../src/modules/semantic/application/quote-grounding.js';
import {validateDecision,resolveDecision} from '../../src/modules/semantic/application/decision-validator.js';
import {TargetResolver} from '../../src/modules/semantic/application/target-resolver.js';
import {TemporalNormalizer} from '../../src/modules/semantic/application/temporal-normalizer.js';
import {IanaTimeResolver} from '../../src/infrastructure/time/iana-time-resolver.js';
/** Offline replay only. Does not import or invoke any HTTP/AI provider. */
export async function replayCheckpoint60(){
 const rows=[];
 for(const c of probeCases()){
  const old=third.results.find(r=>r.id===c.id)!;const privacy=preparePrivacy(c.pack,{externalAllowed:true});if(privacy.route==='denied')throw Error('SYNTHETIC_PRIVACY_DENIED');
  const grounded=groundMeaningDraft(parseMeaningDraft(old.result.decision),privacy.sourceMap),time=new TemporalNormalizer(new IanaTimeResolver());
  const bindings=Object.fromEntries(c.pack.candidates.map((t,i)=>[t.label,{id:'00000000-0000-4000-8000-'+String(i+1).padStart(12,'0'),version:1}]));
  const snapshot={provider:c.pack,bindings,anchors:c.pack.anchors.map(a=>({label:a.label,kind:a.kind,tasks:a.candidateLabels.map(l=>bindings[l]!)}))};
  const resolver=new TargetResolver(snapshot,async(title,q,limit)=>c.pack.candidates.filter(t=>t.title.toLocaleLowerCase('ru').includes(title.toLocaleLowerCase('ru'))&&(!q.status||q.status===t.status)&&(!q.date||q.date===t.targetDate)).slice(0,limit).map(t=>bindings[t.label]!));
  const checked=validateDecision(grounded,c.pack.sourceLabel,{source:c.pack,time});const groups=await resolveDecision(checked,resolver,time,c.pack);
  rows.push({id:c.id,kind:'local_saved_response_replay',newApiCalls:0,originalProbeAudit:old.audit,groups});
 }
 return {kind:'offline_checkpoint60_replay',modelInvocations:0,rows};
}
