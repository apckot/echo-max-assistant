export class ExternalDeadlineError extends Error {constructor(){super('EXTERNAL_DEADLINE');}}
export async function withDeadline<T>(milliseconds:number,run:(signal:AbortSignal)=>Promise<T>,parent?:AbortSignal):Promise<T>{
 if(parent?.aborted||!Number.isFinite(milliseconds)||milliseconds<1||milliseconds>90000)throw new ExternalDeadlineError();
 const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;let abort:()=>void=()=>{};
 try{return await Promise.race([Promise.resolve().then(()=>{if(controller.signal.aborted)throw new ExternalDeadlineError();return run(controller.signal);}),new Promise<never>((_,reject)=>{abort=()=>{controller.abort();reject(new ExternalDeadlineError());};parent?.addEventListener('abort',abort,{once:true});timer=setTimeout(abort,milliseconds);})]);}
 finally{clearTimeout(timer);parent?.removeEventListener('abort',abort);controller.abort();}
}
