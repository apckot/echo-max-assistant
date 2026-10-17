import {test,expect} from 'vitest';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LoadEvidence,markLoadTimeout} from '../../support/load-evidence.js';
test('phase evidence survives timeout and records last progress and cleanup uncertainty',()=>{
 const dir=mkdtempSync(join(tmpdir(),'echo-load-proof-')),p=join(dir,'phases.json');try{const e=new LoadEvidence(p);e.update({phase:'admission',admitted:7,calls:5,completed:3,queue:[{state:'ready',n:4}]});e.close();markLoadTimeout(p);const r=JSON.parse(readFileSync(p,'utf8'));expect(r).toMatchObject({status:'failed',phase:'timeout',lastPhase:'admission',admitted:7,calls:5,completed:3,cleanup:'not_confirmed'});}finally{rmSync(dir,{recursive:true,force:true});}
});

test('an active timeout cannot later turn into success; cleanup evidence survives',()=>{
 const dir=mkdtempSync(join(tmpdir(),'echo-load-proof-')),p=join(dir,'phases.json');try{const e=new LoadEvidence(p);e.update({phase:'drain',completed:9});markLoadTimeout(p);e.update({status:'completed',phase:'completed',cleanup:'complete'});e.close();const r=JSON.parse(readFileSync(p,'utf8'));expect(r.status).toBe('failed');expect(r.lastPhase).toBe('drain');expect(r.completed).toBe(9);expect(r.cleanup).toBe('complete');expect(readFileSync(p+'.jsonl','utf8').trim().split('\n').length).toBeGreaterThan(2);}finally{rmSync(dir,{recursive:true,force:true});}
});
test('small actual application smoke retains phase journal through complete cleanup',async()=>{
 const {stage3Load,acceptStage3Load}=await import('../../support/stage3-load.js');const dir=mkdtempSync(join(tmpdir(),'echo-load-proof-')),p=process.env.ECHO_STAGE3_SMOKE_PHASES??join(dir,'phases.json');try{const result=await stage3Load(false,undefined,p);expect(acceptStage3Load(result)).toBe(true);const r=JSON.parse(readFileSync(p,'utf8'));expect(r).toMatchObject({status:'completed',phase:'cleanup',cleanup:'complete',admitted:10,completed:10,calls:9,sttCalls:3});expect(r.transitions.map((t:any)=>t.phase)).toEqual(expect.arrayContaining(['seeding','admission','drain','completed','cleanup']));}finally{rmSync(dir,{recursive:true,force:true});}
},120000);
test('failure callback preserves a recorded processing cause and confirmed cleanup',()=>{
 const dir=mkdtempSync(join(tmpdir(),'echo-load-proof-')),p=join(dir,'phases.json');try{const e=new LoadEvidence(p);e.update({status:'failed',failure:'LOAD_PROCESSING_FAILED',phase:'cleanup',cleanup:'complete'});e.close();markLoadTimeout(p);expect(JSON.parse(readFileSync(p,'utf8'))).toMatchObject({status:'failed',failure:'LOAD_PROCESSING_FAILED',phase:'cleanup',cleanup:'complete'});}finally{rmSync(dir,{recursive:true,force:true});}
});
test('stalled diagnostic SQL is cancelled, heartbeat persists, cleanup is bounded',async()=>{
 const {startPostgres}=await import('../../support/postgres.js'),{loadQueueProbe}=await import('../../support/load-probe.js');const pg=await startPostgres();const dir=mkdtempSync(join(tmpdir(),'echo-load-proof-')),p=join(dir,'phases.json'),e=new LoadEvidence(p),probe=loadQueueProbe(pg.pool.options.connectionString!);
 try{e.update({phase:'drain',completed:9});const started=Date.now();await expect(probe.sample('SELECT pg_sleep(30)')).rejects.toMatchObject({code:'57014'});await probe.close();expect(Date.now()-started).toBeLessThan(3000);await new Promise(r=>setTimeout(r,1050));expect(JSON.parse(readFileSync(p,'utf8')).elapsedMs).toBeGreaterThan(1000);e.update({cleanup:'complete'});}finally{e.close();await pg.stop();rmSync(dir,{recursive:true,force:true});}
},120000);
