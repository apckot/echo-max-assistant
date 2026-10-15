import {expect,test} from 'vitest';
import second from '../../../docs/progress/stage-3-openai-probe-attempt-2-results.json';
import {preparePrivacy} from '../../../src/modules/privacy/application/privacy-gateway.js';
import {groundMeaningDraft} from '../../../src/modules/semantic/application/quote-grounding.js';
import {parseMeaningDraft,meaningDraftSchema} from '../../../src/modules/semantic/domain/meaning-decision.js';
import {probeCases} from '../../semantic/stage3-probe.js';
import {projectLegacyQuotes} from '../../support/semantic-replay.js';
const pack=(text:string)=>({...probeCases()[0]!.pack,text,candidates:[],anchors:[]});
const frame=(quote:string)=>({version:2,units:[{label:'u1',kind:'context',speechAct:'meta',polarity:'positive',modality:'asserted',authoredByOwner:true,evidence:[{sourceLabel:'S0',quote}],uncertainty:null}],relations:[],actions:[],queries:[],groups:[]});
test('wire evidence has only sourceLabel/quote; application derives code point ranges including emoji',()=>{
 const p=preparePrivacy(pack('😀 До встречи'),{externalAllowed:true});if(p.route==='denied')throw Error('denied');
 expect(meaningDraftSchema.safeParse(frame('До встречи')).success).toBe(true);
 const d=groundMeaningDraft(parseMeaningDraft(frame('До встречи')),p.sourceMap);
 expect(d.decision.units[0]!.evidence[0]).toEqual({sourceLabel:'S0',quote:'До встречи',start:2,end:12});
 const numeric=frame('До встречи');Object.assign(numeric.units[0]!.evidence[0],{start:2,end:12});expect(meaningDraftSchema.safeParse(numeric).success).toBe(false);
});
test('no match, repeated or overlapping matches, foreign source and Unicode normalization do not guess',()=>{
 for(const [source,quote] of [['да да','да'],['ааа','аа'],['Точный текст','точный текст'],['ё','е\u0308']]){
  const p=preparePrivacy(pack(source!),{externalAllowed:true});if(p.route==='denied')throw Error('denied');expect(()=>groundMeaningDraft(parseMeaningDraft(frame(quote!)),p.sourceMap)).toThrow();
 }
 const p=preparePrivacy(pack('Да. Нет.'),{externalAllowed:true});if(p.route==='denied')throw Error('denied');
 const d=frame('Да.');d.units[0]!.evidence[0]!.sourceLabel='S99';expect(()=>groundMeaningDraft(parseMeaningDraft(d),p.sourceMap)).toThrow('EVIDENCE_UNKNOWN_SOURCE');
 expect(groundMeaningDraft(parseMeaningDraft(frame('Да.')),p.sourceMap).decision.units[0]!.evidence[0]!.start).toBe(0);
});
test('SourceMap grounds sanitized quotes back to exact original offsets without leaking raw values to provider',()=>{
 const original='😀 Позвонить Анне завтра';const p=preparePrivacy(pack(original),{externalAllowed:true,knownValues:['Анне']});if(p.route==='denied')throw Error('denied');
 const quote=p.context.pack.text.slice(p.context.pack.text.indexOf('Позвонить'));
 const d=groundMeaningDraft(parseMeaningDraft(frame(quote)),p.sourceMap);
 expect(d.decision.units[0]!.evidence[0]).toEqual({sourceLabel:'S0',quote:'Позвонить Анне завтра',start:2,end:Array.from(original).length});expect(d.sourceMap).toBe(p.sourceMap);
 expect(JSON.stringify(p.context)).not.toContain('Анне');
});
test('saved C015/C016/C034 recover exact ranges locally after dropping only obsolete numeric coordinates',()=>{
 for(const id of ['C015','C016','C034']){
  const row=second.results.find(r=>r.id===id)!;const p=preparePrivacy(probeCases().find(c=>c.id===id)!.pack,{externalAllowed:true});if(p.route==='denied')throw Error('denied');
  const grounded=groundMeaningDraft(parseMeaningDraft(projectLegacyQuotes(row.localResult.decision)),p.sourceMap);
  const walk=(v:any)=>{if(Array.isArray(v))return v.forEach(walk);if(!v||typeof v!=='object')return;if('sourceLabel'in v&&'quote'in v){expect(Array.from(p.sourceMap.sources[v.sourceLabel]!).slice(v.start,v.end).join('')).toBe(v.quote);}Object.values(v).forEach(walk);};walk(grounded.decision);
 }
});
test('source labels distinguish sources, but guessed raw private values and inconsistent SourceMap fail closed',()=>{
 const p=preparePrivacy({...pack('Да'),candidates:[{label:'T1',title:'Да',description:null,status:'open',targetDate:null,scheduledAt:null,deadline:null}]},{externalAllowed:true});if(p.route==='denied')throw Error('denied');
 const draft=frame('Да');draft.units[0]!.evidence[0]!.sourceLabel='T1';expect(groundMeaningDraft(parseMeaningDraft(draft),p.sourceMap).decision.units[0]!.evidence[0]!.start).toBe(0);
 const q=preparePrivacy(pack('Позвонить Анне'),{externalAllowed:true,knownValues:['Анне']});if(q.route==='denied')throw Error('denied');
 expect(()=>groundMeaningDraft(parseMeaningDraft(frame('Анне')),q.sourceMap)).toThrow('EVIDENCE_NO_MATCH');
 expect(()=>groundMeaningDraft(parseMeaningDraft(frame(q.context.pack.text)),{...q.sourceMap,sources:{S0:'other'}})).toThrow('EVIDENCE_SOURCE_MAP_MISMATCH');
});
