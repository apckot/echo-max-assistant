/** Eval dispatch admission only. Never refunds reservations for errors/unknown usage. No network/credentials. */
export class EvalBudget {
 private readonly used=new Set<string>();private reservedUsd=0;
 constructor(private readonly ids:readonly string[],private readonly maxCalls:number,private readonly maxUsd:number){if(!Number.isSafeInteger(maxCalls)||maxCalls<1||!Number.isFinite(maxUsd)||maxUsd<=0||new Set(ids).size!==ids.length)throw Error('BUDGET_CONFIGURATION');}
 reserve(id:string,worstUsd:number){if(!Number.isFinite(worstUsd)||worstUsd<0||!this.ids.includes(id)||this.used.has(id)||this.used.size>=this.maxCalls||this.reservedUsd+worstUsd>this.maxUsd+1e-12)throw Error('BUDGET_REFUSED');this.used.add(id);this.reservedUsd+=worstUsd;}
 snapshot(){return {calls:this.used.size,reservedUsd:this.reservedUsd};}
}
