import {createHash} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import regressions from '../fixtures/stage3/regressions.json';
import {meaningDraftJsonSchema} from '../../src/modules/semantic/domain/meaning-decision.js';
import {meaningPrompt} from '../../src/infrastructure/ai/meaning-prompt.js';
function tree(root:string):string[]{return readdirSync(root,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(d=>d.isDirectory()?tree(join(root,d.name)):[join(root,d.name)]);}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
export const evalInventory=Object.freeze(regressions.cases.map(c=>Object.freeze({id:c.id,mode:c.sourceAndMode.split('/')[1]!.trim().split(' ')[0]!,oracleHash:hash(c.oracle),scenarioHash:hash(c.scenario)})));
export const finalEvalRequest=Object.freeze({semanticMax:125,sttMax:27,maxUsd:10,maxInputTokens:12000,maxOutputTokens:2000,semanticWorstUsd:5,audioMaxMinutes:90,audioEstimatedUsd:.27,priceEvidence:'https://developers.openai.com/api/docs/pricing',checkedAt:'2026-10-16',retries:0});
/** Metadata only: never loads private holdout/audio assets, credentials or invokes a provider. */
export function freezeEvalProfile(){return {model:'gpt-4.1-2025-04-14',sttModel:'gpt-4o-mini-transcribe-2025-12-15',api:'responses/v1 + audio/transcriptions/v1',hashes:{sourceTree:hash([...tree('src'),...tree('tests/semantic')].map(p=>JSON.stringify([p,hash(readFileSync(p,'utf8'))])).join('\n')),prompt:hash(meaningPrompt),schema:hash(JSON.stringify(meaningDraftJsonSchema)),inventory:hash(JSON.stringify(evalInventory)),privacy:hash(readFileSync('src/modules/privacy/application/privacy-gateway.ts','utf8')),runtime:hash(readFileSync('src/runtime/assistant.ts','utf8')),oracles:hash(readFileSync('tests/semantic/oracle.ts','utf8')),runner:hash(readFileSync('tests/semantic/corpus-runner.ts','utf8'))},request:finalEvalRequest};}
const required=['native_codec','independent_H20','audio_assets','audio_route','billing_cap','R_oracles','owner_authorisation'] as const;
export function evalReadiness(proof:Partial<Record<typeof required[number],boolean>>){return required.filter(k=>proof[k]!==true);}
