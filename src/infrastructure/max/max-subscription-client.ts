import { z } from 'zod';
import type { SubscriptionClient } from '../../modules/operations/application/subscription-monitor.js';
const listSchema=z.object({subscriptions:z.array(z.object({url:z.url(),update_types:z.array(z.string())})).max(100)});
export function createMaxSubscriptionClient(options:{token:string;baseUrl?:string;timeoutMs?:number;operationBudgetMs?:number}):SubscriptionClient {
  const base=new URL(options.baseUrl??'https://platform-api2.max.ru');
  if(base.username || base.password || base.search || base.hash || base.pathname!=='/' ||
    (base.protocol!=='https:' && !(base.protocol==='http:' && ['127.0.0.1','localhost','[::1]'].includes(base.hostname))))
    throw new Error('invalid_subscription_configuration');
  const timeoutMs=options.timeoutMs??5000;const budgetMs=options.operationBudgetMs??20_000;
  if(![timeoutMs,budgetMs].every(n=>Number.isSafeInteger(n)&&n>0) || timeoutMs>5000 || budgetMs>20_000)
    throw new Error('invalid_subscription_configuration');
  let budget:AbortSignal|undefined;
  async function request(method:string,body?:object,url?:string,authority?:AbortSignal):Promise<unknown> {
    try {
      const target=new URL('/subscriptions',base);if(url)target.searchParams.set('url',url);
      const response=await fetch(target,{method,redirect:'error',headers:{Authorization:options.token,'Content-Type':'application/json'},
        body:body?JSON.stringify(body):undefined,signal:AbortSignal.any([AbortSignal.timeout(timeoutMs),...(budget?[budget]:[]),...(authority?[authority]:[])])});
      if(!response.ok){void response.body?.cancel().catch(()=>{});throw new Error();}
      const reader=response.body?.getReader();if(!reader)throw new Error();
      const chunks:Uint8Array[]=[];let size=0;
      try {while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;
        if(size>65536){void reader.cancel().catch(()=>{});throw new Error();}chunks.push(part.value);}}
      finally{reader.releaseLock();}
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }catch{throw new Error('max_subscription_failed');}
  }
  async function mutate(method:string,body?:object,url?:string,authority?:AbortSignal){
    const result=z.object({success:z.literal(true)}).safeParse(await request(method,body,url,authority));
    if(!result.success)throw new Error('max_subscription_failed');
  }
  return {list:async(authority)=>{
    budget=AbortSignal.timeout(budgetMs);
    const result=listSchema.safeParse(await request('GET',undefined,undefined,authority));if(!result.success)throw new Error('max_subscription_failed');
    return result.data.subscriptions.map(s=>({url:s.url,updateTypes:s.update_types}));
  },install:(url,types,secret,authority)=>mutate('POST',{url,update_types:types,secret},undefined,authority),remove:(url,authority)=>mutate('DELETE',undefined,url,authority)};
}
