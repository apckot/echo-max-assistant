import type {MeaningDraft} from '../domain/meaning-decision.js';
export interface ContextCandidate {readonly label:string;readonly title:string;readonly description:string|null;readonly descriptionTruncated?:boolean;readonly status:'open'|'completed'|'cancelled';readonly targetDate:string|null;readonly scheduledAt:string|null;readonly deadline:string|null}
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
export interface ProviderUsage {readonly inputTokens:number;readonly outputTokens:number}
export type InvalidReason='response_size'|'response_json'|'response_shape'|'incomplete'|'missing_output'|'decision_json'|'meaning_schema'|'meaning_references';
export type ProviderResult={readonly outcome:'ok';readonly decision:MeaningDraft;readonly model:string;readonly durationMs:number;readonly usage:ProviderUsage|null}
 |{readonly outcome:'invalid';readonly reason:InvalidReason;readonly durationMs:number;readonly usage:ProviderUsage|null;readonly model?:string}
 |{readonly outcome:'denied'|'timeout'|'uncertain'|'http_error'|'refusal';readonly durationMs:number;readonly status?:number;readonly usage?:ProviderUsage|null};

export interface AiDecisionProvider {decide(context:ProviderContext,registry:ToolRegistryV1,schemaVersion:2,deadline:Date,signal:AbortSignal):Promise<ProviderResult>}
