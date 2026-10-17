import {test,expect} from 'vitest';
import {writeFileSync} from 'node:fs';
import {markLoadFailure} from '../support/load-evidence.js';
import {stage3Load,acceptStage3Load} from '../support/stage3-load.js';
test('Stage3 two-worker bounded fake-provider orchestration profile',async(context)=>{
 const phases=process.env.ECHO_STAGE3_LOAD_PHASES;context.onTestFailed(({errors})=>{if(phases)markLoadFailure(phases,errors.some(e=>/Test timed out in/.test(e.message)));});
 const r=await stage3Load(true,undefined,phases);expect(acceptStage3Load(r)).toBe(true);expect(r.operations).toBe(160);expect(r.counts.processed).toBe(160);expect(r.failures).toBe(0);expect(r.stats.every(s=>s.maxAi<=4&&s.maxStt<=2)).toBe(true);expect(r.calls).toBeLessThanOrEqual(160);expect(r.sttCalls).toBeLessThanOrEqual(40);
 if(process.env.ECHO_STAGE3_LOAD_REPORT)writeFileSync(process.env.ECHO_STAGE3_LOAD_REPORT,JSON.stringify(r,null,2)+'\n');console.log('STAGE3_LOAD '+JSON.stringify(r));
},240000);
