import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {preparePrivacy} from '../../src/modules/privacy/application/privacy-gateway.js';
import {parseMeaningDraft} from '../../src/modules/semantic/domain/meaning-decision.js';
import {groundMeaningDraft} from '../../src/modules/semantic/application/quote-grounding.js';
import {validateTemporalIntent} from '../../src/modules/semantic/application/temporal-intent.js';
import {projectLegacyQuotes} from '../support/semantic-replay.js';
import {probeCases,auditGroundedProbe} from './stage3-probe.js';
const root=resolve(fileURLToPath(new URL('../../',import.meta.url)));
const saved=JSON.parse(readFileSync(resolve(root,'docs/progress/stage-3-openai-probe-attempt-2-results.json'),'utf8'));
const cases=['C015','C016','C034'].map(id=>{
 const original=saved.results.find((r:{id:string})=>r.id===id).localResult.decision;
 const projected=projectLegacyQuotes(original),p=preparePrivacy(probeCases().find(c=>c.id===id)!.pack,{externalAllowed:true});if(p.route==='denied')throw Error('LOCAL_FIXTURE_DENIED');
 const grounded=groundMeaningDraft(parseMeaningDraft(projected),p.sourceMap),before=JSON.stringify(grounded.decision);
 const temporal=validateTemporalIntent(grounded),oracle=auditGroundedProbe(id,grounded),spans=new Map<string,unknown>();
 const walk=(v:unknown):void=>{if(Array.isArray(v)){v.forEach(walk);return;}if(!v||typeof v!=='object')return;const o=v as Record<string,unknown>;if(typeof o.start==='number'&&typeof o.end==='number'&&typeof o.sourceLabel==='string'&&typeof o.quote==='string'){
  if(Array.from(p.sourceMap.sources[o.sourceLabel]!).slice(o.start,o.end).join('')!==o.quote)throw Error('LOCAL_RANGE_ASSERTION_FAILED');spans.set(JSON.stringify(o),o);
 }Object.values(o).forEach(walk);};walk(grounded.decision);
 return {id,quoteGrounding:'pass',derivedSpans:[...spans.values()],temporal,oracle,decisionUnchangedBySemanticChecks:before===JSON.stringify(grounded.decision),temporalDrafts:grounded.decision.actions.map(a=>({label:a.label,kind:a.kind,times:a.times})),relations:grounded.decision.relations};
});
const report={kind:'offline_saved_response_replay_not_AI_eval',externalContract:'MeaningDraftV2/sourceLabel+quote',internalContract:'MeaningDecisionV1/exact code-point spans+SourceMap',model:'gpt-4.1-2025-04-14',newApiCalls:0,historicalProbeResultsRegraded:false,quoteGroundingPassed:3,wrongTemporalCasesRejected:2,cases};
if(!cases.every(c=>c.quoteGrounding==='pass'&&c.decisionUnchangedBySemanticChecks)||cases.filter(c=>!c.temporal.ok).length!==2||cases.filter(c=>!c.oracle.exact).length!==2)throw Error('LOCAL_REPLAY_ASSERTION_FAILED');
writeFileSync(resolve(root,'docs/progress/stage-3-quote-contract-local.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({newApiCalls:0,quoteGroundingPassed:3,wrongTemporalCasesRejected:2}));
