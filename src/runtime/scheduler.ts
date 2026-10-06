import { RetentionService } from '../modules/operations/application/retention-service.js';
import { PostgresRetentionStore } from '../infrastructure/postgres/postgres-retention-store.js';
import { createDatabase } from '../infrastructure/postgres/database.js';
import { PostgresSubscriptionStore } from '../infrastructure/postgres/postgres-subscription-store.js';
import { createMaxSubscriptionClient } from '../infrastructure/max/max-subscription-client.js';
import { SubscriptionMonitor } from '../modules/operations/application/subscription-monitor.js';
import { parseRuntimeConfig } from '../shared/config/config.js';
export function createScheduler(environment:Record<string,unknown>,options:{baseUrl?:string;automatic?:boolean}={}) {
  const config=parseRuntimeConfig(environment);
  if(!config.MAX_WEBHOOK_SECRET_VERSION)throw new Error('subscription_secret_version_required');
  const database=createDatabase({scheduler:config.DATABASE_URL_SCHEDULER,poolSize:2,schedulerTransactionTimeoutMs:30_000});
  const monitor=new SubscriptionMonitor(new PostgresSubscriptionStore(database),createMaxSubscriptionClient({token:config.MAX_BOT_TOKEN,baseUrl:options.baseUrl}),
    {url:config.MAX_WEBHOOK_URL,secret:config.MAX_WEBHOOK_SECRET,version:config.MAX_WEBHOOK_SECRET_VERSION});
  const retention=new RetentionService(new PostgresRetentionStore(database));
  let cleaning:Promise<unknown>|undefined;
  const clean=()=>{
    if(stopping || config.RESTORE_FENCE==='on')return Promise.resolve();
    return cleaning??=retention.run().finally(()=>{cleaning=undefined;});
  };
  let stopping=false;let stopped:Promise<void>|undefined;
  let checking:Promise<void>|undefined;let scanning:Promise<{conversation:number;delivery:number}>|undefined;
  const checkSubscription=()=>{
    if(stopping || config.RESTORE_FENCE==='on')return Promise.resolve();
    return checking??=monitor.check().finally(()=>{checking=undefined;});
  };
  const scan=()=>{
    if(stopping || config.RESTORE_FENCE==='on')return Promise.resolve({conversation:0,delivery:0});
    return scanning??=database.systemTransaction('scheduler',async tx=>{
      const [row]=await tx.query<{counts:{conversation:number;delivery:number}}>('SELECT public.scheduler_safety_scan(100) AS counts');
      return row!.counts;
    }).finally(()=>{scanning=undefined;});
  };
  const timers:ReturnType<typeof setInterval>[]=[];
  if(options.automatic!==false){
    timers.push(setInterval(()=>{void clean().catch(()=>{});},60_000),setInterval(()=>{void scan().catch(()=>{});},5000),setInterval(()=>{void checkSubscription().catch(()=>{});},300_000));
    void scan().catch(()=>{});void checkSubscription().catch(()=>{});
  }
  return {checkSubscription,scan,clean,stop(){return stopped??=(async()=>{
    stopping=true;for(const timer of timers)clearInterval(timer);
    await Promise.allSettled([checking,scanning,cleaning]);await database.close();
  })();}};
}
