import {test,expect} from 'vitest';
import {writeFileSync} from 'node:fs';
import {replayCheckpoint60} from '../../semantic/checkpoint60-replay.js';
test('all twelve saved synthetic responses traverse current local validators without AI or semantic repair',async()=>{
 const report=await replayCheckpoint60();expect(report.rows).toHaveLength(12);expect(report.modelInvocations).toBe(0);
 expect(report.rows.every(r=>r.originalProbeAudit.exact&&r.originalProbeAudit.safety)).toBe(true);
 const reject=report.rows.filter(r=>r.groups.some(g=>g.status==='blocked')).map(r=>({id:r.id,reasons:r.groups.flatMap(g=>g.reasons)}));
 if(process.env.ECHO_LOCAL_REPLAY_REPORT)writeFileSync(process.env.ECHO_LOCAL_REPLAY_REPORT,JSON.stringify({...report,correctProbeResponsesRejectedLocally:reject},null,2)+'\n');
 expect(reject).toEqual([]);
 // Confirmed reply authority resolves C020; no saved decision is rewritten.
 expect(report.rows.find(r=>r.id==='C034')?.groups.map(g=>g.status)).toEqual(['ready','choice']);
});
