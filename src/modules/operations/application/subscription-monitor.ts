export const subscriptionTypes=['message_created','message_callback','bot_started','bot_stopped'] as const;
export type Subscription={url:string;updateTypes:readonly string[]};
export interface SubscriptionClient {
  list(signal?:AbortSignal):Promise<readonly Subscription[]>;
  remove(url:string,signal?:AbortSignal):Promise<void>;
  install(url:string,types:readonly string[],secret:string,signal?:AbortSignal):Promise<void>;
}
export type SubscriptionHealth={status:'healthy'|'degraded'|'critical';failures:number;secretVersion:string|null};
export interface SubscriptionStore {
  withLeader(fn:(state:SubscriptionHealth|null,save:(health:SubscriptionHealth)=>Promise<void>,signal?:AbortSignal)=>Promise<void>):Promise<void>;
}
export class SubscriptionMonitor {
  constructor(private readonly store:SubscriptionStore,private readonly client:SubscriptionClient,
    private readonly desired:{url:string;secret:string;version:string}) {}
  check() { return this.store.withLeader(async(state,save,signal)=>{
    try {
      const entries=await this.client.list(signal);
      const matches=entries.length===1 && entries[0]!.url===this.desired.url &&
        entries[0]!.updateTypes.length===subscriptionTypes.length && subscriptionTypes.every(t=>entries[0]!.updateTypes.includes(t));
      if(!matches || state?.secretVersion!==this.desired.version) {
        // MAX's POST updates the desired URL. Remove other endpoints owned by this single-bot runtime.
        for(const entry of entries) if(entry.url!==this.desired.url) await this.client.remove(entry.url,signal);
        await this.client.install(this.desired.url,subscriptionTypes,this.desired.secret,signal);
      }
      await save({status:'healthy',failures:0,secretVersion:this.desired.version});
    }catch{
      const failures=(state?.failures??0)+1;
      await save({status:failures>=3?'critical':'degraded',failures,secretVersion:state?.secretVersion??null});
    }
  }); }
}
