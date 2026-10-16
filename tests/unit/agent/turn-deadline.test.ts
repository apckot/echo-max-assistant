import {test,expect} from 'vitest';
import {withDeadline} from '../../../src/shared/time/deadline.js';
test('authority/worker cancellation aborts a non-settling external port without waiting for its deadline',async()=>{
 const started=performance.now();const controller=new AbortController();let seen:AbortSignal|undefined;
 const pending=withDeadline(1000,signal=>{seen=signal;return new Promise<never>(()=>{});},controller.signal);await Promise.resolve();controller.abort();
 await expect(pending).rejects.toThrow('EXTERNAL_DEADLINE');expect(seen?.aborted).toBe(true);expect(performance.now()-started).toBeLessThan(200);
});
