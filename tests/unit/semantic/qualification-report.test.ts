import {test,expect} from 'vitest';
import {evalInventory,finalEvalRequest,freezeEvalProfile,evalReadiness} from '../../semantic/stage3-eval.config.js';
test('frozen inventory separates every regression mode and exact bounded dispatch budget',()=>{
 expect(Object.fromEntries(['R','V','F','P'].map(m=>[m,evalInventory.filter(c=>c.mode===m).length]))).toEqual({R:78,V:7,F:9,P:7});
 expect(finalEvalRequest).toMatchObject({semanticMax:125,sttMax:27,maxUsd:10,semanticWorstUsd:5,audioEstimatedUsd:.27});
 const profile=freezeEvalProfile();expect(profile.hashes.prompt).toMatch(/^[a-f0-9]{64}$/);expect(profile.hashes.schema).toMatch(/^[a-f0-9]{64}$/);expect(profile.model).toBe('gpt-4.1-2025-04-14');
 expect(evalReadiness({})).toEqual(expect.arrayContaining(['native_codec','independent_H20','audio_assets','audio_route','billing_cap','R_oracles','owner_authorisation']));
 expect(evalReadiness({native_codec:true,independent_H20:true,audio_assets:true,audio_route:true,billing_cap:true,R_oracles:true,owner_authorisation:true})).toEqual([]);
});
