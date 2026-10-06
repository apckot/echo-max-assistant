import { createGateway } from './gateway.js';
import { createWorker } from './worker.js';
import { createDelivery } from './delivery.js';
import { createScheduler } from './scheduler.js';

const role=process.argv[2];
let close:()=>Promise<unknown>=async()=>{};
// Fenced background roles must remain alive even when they have no DB timers/work.
const keepAlive=setInterval(()=>{},1000);
let stopping:Promise<void>|undefined;
let startup:Promise<void>;
function stop(){return stopping??=(async()=>{
 const deadline=setTimeout(()=>{console.error('runtime_shutdown_timeout');process.exit(1);},60_000);
 try{await startup;await close();console.log(JSON.stringify({event:'runtime_stopped',role}));}
 catch{console.error('runtime_shutdown_failed');process.exitCode=1;}
 finally{clearTimeout(deadline);clearInterval(keepAlive);}
})();}
process.once('SIGTERM',()=>{void stop();});process.once('SIGINT',()=>{void stop();});
startup=(async()=>{
 if(role==='gateway'){
  const port=Number(process.env.PORT??8080);if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid port');
  const app=createGateway(process.env);close=()=>app.close();await app.listen({port,host:'0.0.0.0'});
 }else if(role==='worker')close=createWorker(process.env).stop;
 else if(role==='delivery')close=createDelivery(process.env).stop;
 else if(role==='scheduler')close=createScheduler(process.env).stop;
 else throw Error('Role must be gateway, worker, delivery or scheduler');
 console.log(JSON.stringify({event:'runtime_started',role}));
})();
void startup.catch(()=>{console.error('runtime_startup_failed');process.exitCode=1;void stop();});
