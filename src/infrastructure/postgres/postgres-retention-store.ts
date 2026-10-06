import type { Database } from './database.js';
import type { RetentionStore,RetentionCounts } from '../../modules/operations/application/retention-service.js';
export class PostgresRetentionStore implements RetentionStore {
  constructor(private readonly database:Database){}
  clean(asOf:Date,limit:number){return this.database.systemTransaction('scheduler',async tx=>{
    const [row]=await tx.query<{counts:RetentionCounts}>('SELECT public.retain_technical_records($1,$2) AS counts',[asOf,limit]);
    return row!.counts;
  });}
}
