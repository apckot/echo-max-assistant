import type { UserId } from '../../../shared/types/identity.js';
export type DeleteRequest={userId:UserId;operationId:string;actor:'operator'|'self_service';reason:'privacy_request'};
export type DeleteResult={status:'preview'|'pending'|'waiting'|'completed'|'absent';counts:Record<string,number>};
export interface AccountDeletionStore {
  execute(input:DeleteRequest,mode:'preview'|'begin'|'finish'):Promise<DeleteResult>;
  pending(limit:number):Promise<readonly DeleteRequest[]>;
}
export class DeleteAccount {
  constructor(private readonly store:AccountDeletionStore){}
  preview(input:DeleteRequest){return this.store.execute(input,'preview');}
  begin(input:DeleteRequest){return this.store.execute(input,'begin');}
  finish(input:DeleteRequest){return this.store.execute(input,'finish');}
  async apply(input:DeleteRequest){const result=await this.begin(input);return result.status==='pending'?this.finish(input):result;}
  async resume(limit=10){
    if(!Number.isSafeInteger(limit)||limit<1||limit>10)throw new RangeError('invalid_deletion_batch');
    let completed=0;for(const input of await this.store.pending(limit))if((await this.finish(input)).status==='completed')completed++;
    return {completed};
  }
}
