export class ExternalDeadlineError extends Error {constructor(){super('EXTERNAL_DEADLINE');}}
export async function withDeadline<T>(milliseconds:number,run:(signal:AbortSignal)=>Promise<T>):Promise<T>{
 if(!Number.isFinite(milliseconds)||milliseconds<1||milliseconds>90000)throw new ExternalDeadlineError();
 const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([Promise.resolve().then(()=>run(controller.signal)),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new ExternalDeadlineError());},milliseconds);})]);}
 finally{clearTimeout(timer);controller.abort();}
}
