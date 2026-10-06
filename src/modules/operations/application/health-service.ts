export type HealthSnapshot = {
  schemaVersion:number; restoreFence:boolean; migrations:Record<string,string>;
  queue:{depth:number;lagSeconds:number;expiredLeases:number};
  delivery:{pending:number;cancelled:number;uncertain:number;expiredLeases:number};
  subscription:{status:string;failures?:number;checkedAt?:string}; backup:string; deletion:{pending:number};
};
export interface HealthStore { snapshot():Promise<HealthSnapshot> }
export class HealthService {
  constructor(private readonly store:HealthStore,private readonly expected:Record<string,string>,
    private readonly configuredFence:boolean) {}
  async check() {
    try {
      const {migrations,...snapshot}=await this.store.snapshot();
      const matching=Object.keys(migrations).length===Object.keys(this.expected).length &&
        Object.entries(this.expected).every(([name,checksum])=>migrations[name]===checksum);
      const ready=!this.configuredFence && !snapshot.restoreFence && matching &&
        snapshot.schemaVersion===Object.keys(this.expected).length;
      return {ready,...snapshot};
    } catch { return {ready:false,code:'health_unavailable' as const}; }
  }
}
