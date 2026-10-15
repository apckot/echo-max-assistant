import type {MeaningDecision} from '../domain/meaning-decision.js';
export interface ContextCandidate {readonly label:string;readonly title:string;readonly description:string|null;readonly status:'open'|'completed'|'cancelled';readonly targetDate:string|null;readonly scheduledAt:string|null;readonly deadline:string|null}
export interface InternalContextPack {
 readonly text:string;readonly sourceLabel:string;readonly sourceAt:string;readonly timezone:string;
 readonly candidates:readonly ContextCandidate[];
 readonly anchors:readonly {readonly label:string;readonly kind:'reply'|'list';readonly candidateLabels:readonly string[]}[];
 readonly history:readonly {readonly role:'user'|'assistant';readonly text:string}[];
 readonly pendingChoices:readonly {readonly label:string;readonly topic:string}[];
}
export interface ProviderContext {readonly kind:'privacy_approved_v1';readonly pack:InternalContextPack;readonly route:'external_allowed'|'tokenized'}
export interface ToolRegistryV1 {readonly version:1;readonly commands:readonly ['create','update','complete','cancel','reopen'];readonly queries:readonly ['open','day','find','history','capabilities']}
export const taskRegistry:ToolRegistryV1={version:1,commands:['create','update','complete','cancel','reopen'],queries:['open','day','find','history','capabilities']};
export type ProviderResult={readonly outcome:'ok';readonly decision:MeaningDecision;readonly model:string;readonly durationMs:number;readonly usage:{readonly inputTokens:number;readonly outputTokens:number}|null}|{readonly outcome:'denied'|'timeout'|'uncertain'|'http_error'|'invalid'|'refusal';readonly durationMs:number;readonly status?:number};
export interface AiDecisionProvider {decide(context:ProviderContext,registry:ToolRegistryV1,schemaVersion:1,deadline:Date,signal:AbortSignal):Promise<ProviderResult>}
