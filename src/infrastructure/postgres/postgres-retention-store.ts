import type { Database } from './database.js';
import type { RetentionStore,RetentionCounts } from '../../modules/operations/application/retention-service.js';
export class PostgresRetentionStore implements RetentionStore {
  constructor(private readonly database:Database){}
  cleanNow(limit:number){return this.database.systemTransaction('scheduler',async tx=>{
    const [row]=await tx.query<{counts:RetentionCounts}>('SELECT public.retain_technical_records(clock_timestamp(),$1) AS counts',[limit]);
    await tx.query('SELECT public.retain_privacy_maps($1),public.retain_agent_content($1),public.expire_media_preparations($1),public.cleanup_media_metadata($1)',[limit]);
    return row!.counts;
  });}
  clean(asOf:Date,limit:number){return this.database.systemTransaction('scheduler',async tx=>{
    const [row]=await tx.query<{counts:RetentionCounts}>('SELECT public.retain_technical_records($1,$2) AS counts',[asOf,limit]);
    await tx.query('SELECT public.retain_privacy_maps($1),public.retain_agent_content($1),public.expire_media_preparations($1),public.cleanup_media_metadata($1)',[limit]);
    return row!.counts;
  });}
}
