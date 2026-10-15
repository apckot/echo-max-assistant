import {parseMeaningDraft,parseMeaning,type MeaningDecision,type MeaningDraft,type SpanRef} from '../domain/meaning-decision.js';
import {rehydrate,type SourceMap} from '../../privacy/application/source-map.js';
/** Source-grounded is not yet semantic approval or permission to execute Tasks. */
export interface GroundedMeaning {readonly decision:MeaningDecision;readonly sourceMap:SourceMap}
function exactRange(source:string,quote:string):number{
 if(!quote||[...source,...quote].some(c=>c.length===1&&c.charCodeAt(0)>=0xd800&&c.charCodeAt(0)<=0xdfff))throw Error('EVIDENCE_INVALID_UNICODE');
 const start=source.indexOf(quote);
 if(start<0)throw Error('EVIDENCE_NO_MATCH');
 // Advance one UTF16 unit to count overlapping occurrences too; well-formed strings prevent split surrogate matches.
 if(source.indexOf(quote,start+1)>=0)throw Error('EVIDENCE_AMBIGUOUS');
 return start;
}
function groundQuote(ref:{sourceLabel:string;quote:string},map:SourceMap):SpanRef{
 const provider=map.providerSources[ref.sourceLabel],original=map.sources[ref.sourceLabel];
 if(!Object.hasOwn(map.providerSources,ref.sourceLabel)||!Object.hasOwn(map.sources,ref.sourceLabel)||provider===undefined||original===undefined)throw Error('EVIDENCE_UNKNOWN_SOURCE');
 if(rehydrate(provider,map)!==original)throw Error('EVIDENCE_SOURCE_MAP_MISMATCH');
 const index=exactRange(provider,ref.quote),prefix=rehydrate(provider.slice(0,index),map),quote=rehydrate(ref.quote,map);
 const start=Array.from(prefix).length,end=start+Array.from(quote).length;
 if(end<=start||Array.from(original).slice(start,end).join('')!==quote)throw Error('EVIDENCE_SOURCE_MAP_MISMATCH');
 return {sourceLabel:ref.sourceLabel,quote,start,end};
}
export function groundMeaningDraft(value:MeaningDraft,map:SourceMap):GroundedMeaning{
 const draft=parseMeaningDraft(value);
 const walk=(v:unknown):unknown=>{
  if(typeof v==='string')return rehydrate(v,map);
  if(Array.isArray(v))return v.map(walk);
  if(!v||typeof v!=='object')return v;
  const o=v as Record<string,unknown>;
  if(typeof o.sourceLabel==='string'&&typeof o.quote==='string')return groundQuote({sourceLabel:o.sourceLabel,quote:o.quote},map);
  return Object.fromEntries(Object.entries(o).map(([k,x])=>[k,walk(x)]));
 };
 return {decision:parseMeaning({...walk(draft) as Record<string,unknown>,version:1}),sourceMap:map};
}
