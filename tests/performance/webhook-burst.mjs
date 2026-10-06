import {performance} from 'node:perf_hooks';
export const percentile=(values,p)=>{if(!values.length)throw Error('Missing samples');const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.max(0,Math.ceil(p*sorted.length)-1)];};
export function assess(m){return [['webhook_p95',m.webhookP95Ms,200],['webhook_p99',m.webhookP99Ms,500],['queue_wake_p95',m.queueWakeP95Ms,250],['backlog_drain',m.drainMs,120000]].filter(([,v,max])=>!Number.isFinite(v)||v>max).map(([name])=>name);}
export async function burst({url,secret,rps,seconds,offset=0}){
 if(!Number.isInteger(rps)||rps<1||seconds<1)throw Error('Invalid load');
 const samples=[],started=performance.now(),pending=[];let maxSchedulingLagMs=0;
 // Open-loop schedule: slow responses never lower the offered request rate.
 for(let i=0;i<rps*seconds;i++){
  const due=started+i*1000/rps;await new Promise(r=>setTimeout(r,Math.max(0,due-performance.now())));
  maxSchedulingLagMs=Math.max(maxSchedulingLagMs,performance.now()-due);
  pending.push((async()=>{const t=performance.now(),id=String(offset+i+1);
   const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-max-bot-api-secret':secret},
    signal:AbortSignal.timeout(5000),body:JSON.stringify({update_type:'message_created',timestamp:String(Date.now()),
    message:{sender:{user_id:id,is_bot:false},recipient:{chat_id:id,chat_type:'dialog'},body:{mid:`load-${id}`,text:'foundation load'}}})});
   await response.arrayBuffer();samples.push(performance.now()-t);if(response.status!==200)throw Error('Ingress boundary HTTP '+response.status);
  })());
 }
 await Promise.all(pending);
 return {offeredRps:rps,seconds,requests:samples.length,webhookP95Ms:percentile(samples,.95),webhookP99Ms:percentile(samples,.99),maxSchedulingLagMs};
}
