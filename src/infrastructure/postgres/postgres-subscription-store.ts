import type { Database } from './database.js';
import type { SubscriptionStore,SubscriptionHealth } from '../../modules/operations/application/subscription-monitor.js';
export class PostgresSubscriptionStore implements SubscriptionStore {
  constructor(private readonly database:Database) {}
  async withLeader(fn:(state:SubscriptionHealth|null,save:(health:SubscriptionHealth)=>Promise<void>,signal?:AbortSignal)=>Promise<void>) {
    let reconciliation:Promise<void>|undefined;
    try { await this.database.systemTransaction('scheduler',async tx=>{
      const [lock]=await tx.query<{locked:boolean}>('SELECT pg_try_advisory_xact_lock(1698727768,1937072755) AS locked');
      if(!lock?.locked)return;
      const [state]=await tx.query<SubscriptionHealth>(`SELECT status,failures,secret_version AS "secretVersion"
        FROM public.integration_health WHERE component='max_subscription'`);
      reconciliation=fn(state??null,async health=>{
        await tx.query(`INSERT INTO public.integration_health(component,status,failures,secret_version)
          VALUES ('max_subscription',$1,$2,$3) ON CONFLICT(component) DO UPDATE SET
          status=$1,failures=$2,secret_version=$3,checked_at=clock_timestamp()`,[health.status,health.failures,health.secretVersion]);
        if(health.status==='critical') await tx.query(`INSERT INTO public.operations_alerts(code) VALUES ('max_subscription_critical')
          ON CONFLICT(code) DO UPDATE SET raised_at=CASE WHEN operations_alerts.resolved_at IS NOT NULL THEN clock_timestamp()
            ELSE operations_alerts.raised_at END,resolved_at=NULL`);
        else if(health.status==='healthy')await tx.query(`UPDATE public.operations_alerts SET resolved_at=clock_timestamp()
          WHERE code='max_subscription_critical' AND resolved_at IS NULL`);
      },tx.signal);
      await reconciliation;
    }); } finally {
      // The DB deadline cancels authority; retain the actual HTTP callback until
      // it has observed cancellation, so runtime stop cannot detach network work.
      await reconciliation?.catch(()=>{});
    }
  }
}
