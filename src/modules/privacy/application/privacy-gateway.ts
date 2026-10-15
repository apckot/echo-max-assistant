import type {InternalContextPack,ProviderContext} from '../../semantic/application/provider-port.js';
import type {SourceMap} from './source-map.js';
export {rehydrate} from './source-map.js';
export interface PrivacyPolicy {readonly externalAllowed:boolean;readonly knownValues?:readonly string[];readonly prohibited?:boolean;readonly check?:(pack:InternalContextPack)=>boolean}
export type PrivacyResult={readonly route:'denied';readonly reason:'policy'|'secret'|'invalid'|'check_failed'}|{readonly route:'external_allowed'|'tokenized';readonly context:ProviderContext;readonly sourceMap:SourceMap};
const approved=new WeakSet<object>();
export const isApprovedContext=(value:unknown):value is ProviderContext=>!!value&&typeof value==='object'&&approved.has(value);
const secret=/(?:\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:password|api[_ -]?key|secret|пароль)\s*[:=]\s*\S+)/i;
function freeze<T>(value:T):T{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
export function preparePrivacy(input:InternalContextPack,policy:PrivacyPolicy):PrivacyResult{
 if(!policy.externalAllowed||policy.prohibited)return {route:'denied',reason:'policy'};
 try{
  if(policy.check&&!policy.check(input))return {route:'denied',reason:'check_failed'};
  if(typeof input.text!=='string'||Array.from(input.text).length>32000||input.candidates.length>50||input.history.length>24)return {route:'denied',reason:'invalid'};
  // Rebuild the entire envelope: unknown technical/profile fields never reach the adapter.
  const pack:InternalContextPack={text:input.text,sourceLabel:input.sourceLabel,sourceAt:input.sourceAt,timezone:input.timezone,
   candidates:input.candidates.map(c=>({label:c.label,title:c.title,description:c.description,status:c.status,targetDate:c.targetDate,scheduledAt:c.scheduledAt,deadline:c.deadline})),
   anchors:input.anchors.map(a=>({label:a.label,kind:a.kind,candidateLabels:[...a.candidateLabels]})),
   history:input.history.map(h=>({role:h.role,text:h.text})),pendingChoices:input.pendingChoices.map(p=>({label:p.label,topic:p.topic}))};
  const validLabel=(s:string)=>/^[STRLPH]\d{1,3}$/.test(s);
  const labels=[pack.sourceLabel,...pack.candidates.map(c=>c.label),...pack.anchors.map(a=>a.label),...pack.pendingChoices.map(p=>p.label)];
  if(!labels.every(validLabel)||new Set(labels).size!==labels.length||pack.anchors.some(a=>a.candidateLabels.some(l=>!pack.candidates.some(c=>c.label===l))))return {route:'denied',reason:'invalid'};
  if(secret.test(JSON.stringify(pack)))return {route:'denied',reason:'secret'};
  const values:Record<string,string>={},sources:Record<string,string>={[pack.sourceLabel]:pack.text};
  pack.candidates.forEach(c=>sources[c.label]=c.title);pack.history.forEach((h,i)=>sources['H'+i]=h.text);
  const token=(value:string)=>{const existing=Object.keys(values).find(k=>values[k]===value);if(existing)return existing;const key='TOKEN_'+crypto.randomUUID().replaceAll('-','').toUpperCase();values[key]=value;return key;};
  const sanitize=(text:string)=>{
   for(const value of [...(policy.knownValues??[])].filter(Boolean).sort((a,b)=>b.length-a.length))text=text.split(value).join(token(value));
   return text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\+\d[\d ()-]{8,}\d|\b\d{4}\s?\d{6}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,token);
  };
  const sanitized:InternalContextPack={...pack,text:sanitize(pack.text),candidates:pack.candidates.map(c=>({...c,title:sanitize(c.title),description:c.description===null?null:sanitize(c.description)})),history:pack.history.map(h=>({...h,text:sanitize(h.text)})),pendingChoices:pack.pendingChoices.map(p=>({...p,topic:sanitize(p.topic)}))};
  const route=Object.keys(values).length?'tokenized':'external_allowed';
  const context:ProviderContext=freeze({kind:'privacy_approved_v1',pack:sanitized,route});approved.add(context);
  const providerSources:Record<string,string>={[sanitized.sourceLabel]:sanitized.text};sanitized.candidates.forEach(c=>providerSources[c.label]=c.title);sanitized.history.forEach((h,i)=>providerSources['H'+i]=h.text);
  return {route,context,sourceMap:freeze({values,sources,providerSources})};
 }catch{return {route:'denied',reason:'check_failed'};}
}
