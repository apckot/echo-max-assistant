import {test,expect} from 'vitest';
import {stage3Acceptance} from '../../semantic/final-acceptance.js';
import {freezeEvalProfile} from '../../semantic/stage3-eval.config.js';
import {writeFileSync} from 'node:fs';
test('passing automatic evidence cannot close external callbacks, codec, independent semantic or actual audio evidence',()=>{
 const report=stage3Acceptance({automatic:true,review:true,load:true});expect(report.codeReady).toBe(false);expect(report.openLocal).toEqual(['localPreparation']);expect(report.stageComplete).toBe(false);expect(report.open).toEqual(['callback','codec','semantic','audio','maxConversation']);
 expect(stage3Acceptance({automatic:true,review:true,load:true,localPreparation:true,callback:true,codec:true,semantic:true,audio:true,maxConversation:true}).stageComplete).toBe(true);
 expect(stage3Acceptance({automatic:false,review:true,load:true,localPreparation:true,callback:true,codec:true,semantic:true,audio:true,maxConversation:true}).stageComplete).toBe(false);
});
test('final profile freezes actual source tree and public inventory without touching H or audio content',()=>{
 const p=freezeEvalProfile();expect(p.hashes.sourceTree).toMatch(/^[a-f0-9]{64}$/);expect(p.hashes.inventory).toMatch(/^[a-f0-9]{64}$/);
 if(process.env.ECHO_PROFILE_FREEZE_PATH)writeFileSync(process.env.ECHO_PROFILE_FREEZE_PATH,JSON.stringify(p,null,2)+'\n');
});
