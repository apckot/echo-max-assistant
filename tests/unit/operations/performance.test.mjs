import {expect,test} from 'vitest';
import {assess,percentile} from '../../performance/webhook-burst.mjs';
import {drain} from '../../performance/backlog-drain.mjs';
test('latency thresholds fail any tail or wake regression',()=>{
 expect(percentile([1,2,3,4,500],.99)).toBe(500);
 expect(assess({webhookP95Ms:201,webhookP99Ms:300,queueWakeP95Ms:100,drainMs:1})).toEqual(['webhook_p95']);
 expect(assess({webhookP95Ms:100,webhookP99Ms:501,queueWakeP95Ms:251,drainMs:120001})).toEqual(['webhook_p99','queue_wake_p95','backlog_drain']);
});
test('drain requires every expected receipt and sent output; does not silently accept empty/missing work',async()=>{
 await expect(drain(async()=>({receipts:0,sent:0}),3,{timeoutMs:10,pollMs:1})).rejects.toThrow('backlog');
 expect(await drain(async()=>({receipts:3,sent:3}),3)).toBeGreaterThanOrEqual(0);
});
