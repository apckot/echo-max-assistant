// Run with Node22 --experimental-strip-types; never log a database URL.
import { Pool } from 'pg';
const args=process.argv.slice(2);
const value=(name:string)=>{const i=args.indexOf(name);return i>=0?args[i+1]:undefined;};
const incident=value('--incident-id'),snapshot=value('--snapshot-at');
if(!incident||!snapshot||!process.env.DATABASE_URL_MIGRATIONS){console.error('Require --incident-id UUID --snapshot-at ISO and DATABASE_URL_MIGRATIONS; preview is default');process.exit(64);}
const url=new URL(process.env.DATABASE_URL_MIGRATIONS);
if(url.username!=='echo_migrator'){console.error('Offline echo_migrator required');process.exit(64);}
const pool=new Pool({connectionString:url.toString(),max:1,connectionTimeoutMillis:5000,statement_timeout:30_000});
try{
 const result=await pool.query('SELECT public.reconcile_restore($1,$2,$3) AS result',[incident,snapshot,args.includes('--apply')]);
 console.log(JSON.stringify(result.rows[0].result));
 if(args.includes('--reopen')){if(!args.includes('--apply'))throw Error('Reopen requires apply');await pool.query('SELECT public.reopen_restore($1)',[incident]);console.log('Database fence reopened; change runtime RESTORE_FENCE explicitly after subscription/health checks');}
}catch{console.error('Restore reconciliation failed; preserve fence and inspect operator logs privately');process.exitCode=1;}finally{await pool.end();}
