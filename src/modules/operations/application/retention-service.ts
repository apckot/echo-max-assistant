export type RetentionCounts={conversationWork:number;deliveryWork:number;attempts:number};
export interface RetentionStore { clean(asOf:Date,limit:number):Promise<RetentionCounts> }
export class RetentionService {
  constructor(private readonly store:RetentionStore,private readonly clock:()=>Date=()=>new Date()){}
  async run(limit=100){
    if(!Number.isSafeInteger(limit) || limit<1 || limit>100)throw new RangeError('invalid_retention_batch');
    return this.store.clean(this.clock(),limit);
  }
}
