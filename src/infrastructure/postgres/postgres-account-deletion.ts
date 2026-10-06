import type { Database } from './database.js';
import type { AccountDeletionStore,DeleteRequest,DeleteResult } from '../../modules/identity/application/delete-account.js';
export class PostgresAccountDeletion implements AccountDeletionStore {
  constructor(private readonly database:Database){}
  execute(input:DeleteRequest,mode:'preview'|'begin'|'finish'){
    return this.database.systemTransaction('scheduler',async tx=>{
      const [row]=await tx.query<{result:DeleteResult}>('SELECT public.erase_account($1,$2,$3,$4,$5) AS result',
        [input.userId,input.operationId,input.actor,input.reason,mode]);return row!.result;
    });
  }
  pending(limit:number){return this.database.systemTransaction('scheduler',tx=>tx.query<DeleteRequest>(`
    SELECT user_id AS "userId",operation_id AS "operationId",actor,reason FROM public.account_deletions
    WHERE status='pending' ORDER BY started_at,operation_id LIMIT $1`,[limit]));}
}
