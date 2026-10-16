import {ChoiceTokens,PostgresPendingChoices} from '../infrastructure/postgres/agent/pending-choice.js';
import {PostgresChoiceProcessor} from '../infrastructure/postgres/agent/choice-processing.js';
import {z} from 'zod';
import {MediaService} from '../modules/media/application/media-service.js';
import {VoicePreparation} from '../modules/media/application/transcript.js';
import {PostgresMediaJobs} from '../infrastructure/postgres/media/media-jobs.js';
import {MaxAudioLoader} from '../infrastructure/media/max-audio-loader.js';
import {SandboxCodec} from '../infrastructure/media/sandbox-codec.js';
import {OpenAiSttProvider} from '../infrastructure/media/openai-stt-provider.js';
import {createHash} from 'node:crypto';
import type {Database} from '../infrastructure/postgres/database.js';
import {TurnStore} from '../infrastructure/postgres/agent/turn-store.js';
import {PostgresTurnAuthority} from '../infrastructure/postgres/agent/turn-claim.js';
import {agentTaskQueries,PostgresAgentTaskProcessing} from '../infrastructure/postgres/postgres-typed-task-processing.js';
import {PostgresContextReader} from '../infrastructure/postgres/context/context-reader.js';
import {ContextBuilder} from '../modules/context/application/context-builder.js';
import {TurnCoordinator} from '../modules/agent/application/turn-coordinator.js';
import {GroupRunner} from '../modules/agent/application/group-runner.js';
import {AssistantProcess} from '../modules/agent/application/turn-finalizer.js';
import {PostgresTurnFinalizer} from '../infrastructure/postgres/agent/response-intent.js';
import {IanaTimeResolver} from '../infrastructure/time/iana-time-resolver.js';
import {OpenAiDecisionProvider} from '../infrastructure/ai/openai-decision-provider.js';
import {meaningPrompt} from '../infrastructure/ai/meaning-prompt.js';
import type {AiDecisionProvider} from '../modules/semantic/application/provider-port.js';
export interface AssistantSettings {readonly choicesEnabled?:boolean;readonly apiKey:string;readonly dedupKeysJson:string;readonly mapKeyBase64:string;readonly audioProfileJson?:string;readonly mediaOriginsJson?:string}
export function createAssistantRuntime(database:Database,settings:AssistantSettings,provider?:AiDecisionProvider){
 let keys:{version:number;key:Buffer}[];const mapKey=Buffer.from(settings.mapKeyBase64,'base64');
 try{const parsed:unknown=JSON.parse(settings.dedupKeysJson);if(!Array.isArray(parsed)||!parsed.length||parsed.length>10)throw Error();keys=parsed.map(k=>{if(typeof k.version!=='number'||typeof k.key!=='string')throw Error();return {version:k.version,key:Buffer.from(k.key,'base64')};});if(mapKey.length!==32||!settings.apiKey)throw Error();}catch{throw Error('ASSISTANT_CONFIGURATION_INVALID');}
 const choices=settings.choicesEnabled?new PostgresPendingChoices(new ChoiceTokens(keys)):undefined;
 const time=new IanaTimeResolver(),authority=new PostgresTurnAuthority(database,new TurnStore(database,keys),mapKey),tasks=agentTaskQueries(database);
 const context=new ContextBuilder(tasks,new PostgresContextReader(database));
 const audioProfile=z.strictObject({version:z.number().int().positive(),externalAllowed:z.boolean(),regionAllowed:z.boolean(),categoryAllowed:z.boolean(),retentionAllowed:z.boolean(),requiresContentAnalysis:z.boolean()}).parse(settings.audioProfileJson?JSON.parse(settings.audioProfileJson):{version:1,externalAllowed:false,regionAllowed:false,categoryAllowed:false,retentionAllowed:false,requiresContentAnalysis:false});
 const origins=z.array(z.string()).max(20).parse(settings.mediaOriginsJson?JSON.parse(settings.mediaOriginsJson):[]);
 const voice=new VoicePreparation(new PostgresMediaJobs(authority,audioProfile),new MediaService(new MaxAudioLoader(origins),new SandboxCodec()),new OpenAiSttProvider({apiKey:settings.apiKey}));
 const model='gpt-4.1-2025-04-14',profileDigest=createHash('sha256').update(JSON.stringify([model,meaningPrompt,'privacy_v1','meaning_v2','runtime_v1',audioProfile,origins])).digest('hex');
 const coordinator=new TurnCoordinator(authority,context,tasks,time,provider??new OpenAiDecisionProvider({model,apiKey:settings.apiKey,prompt:meaningPrompt}),{profileDigest,externalAllowed:true,deadlineMs:7000},voice);
 return {process:new AssistantProcess(coordinator,new GroupRunner(new PostgresAgentTaskProcessing(authority,choices)),new PostgresTurnFinalizer(authority)),authority,callbacks:choices?new PostgresChoiceProcessor(authority.ordered,choices):null};
}
