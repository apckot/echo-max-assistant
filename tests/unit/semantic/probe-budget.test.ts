import {expect,test} from 'vitest';
import {ProbeBudget,auditProbe,loadProjectCredential,probeIds} from '../../semantic/stage3-probe.js';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('probe reserves pessimistic spend before dispatch and cannot exceed 12 calls or USD2',()=>{
 const b=new ProbeBudget();for(const id of probeIds)b.reserve(id,1000,2000);expect(()=>b.reserve('C003',1000,2000)).toThrow();
 expect(()=>new ProbeBudget().reserve('C003',12001,2000)).toThrow();expect(()=>new ProbeBudget().reserve('C003',1000,2001)).toThrow();expect(()=>new ProbeBudget().reserve('H001',100,100)).toThrow();
 expect(()=>new ProbeBudget(.001).reserve('C003',12000,2000)).toThrow();expect(b.reservedUsd).toBeCloseTo(.216);
});
test('collector never treats missing or incomplete outputs as success',()=>{
 expect(auditProbe('C013',{outcome:'uncertain',durationMs:1})).toMatchObject({safety:false,exact:false});
 expect(auditProbe('C013',{outcome:'ok',durationMs:1,model:'x',usage:null,decision:{version:2,units:[],actions:[],queries:[],relations:[],groups:[]}})).toMatchObject({safety:true,exact:true});
});
test('credential loader reads existing secrets in memory, fails closed without echoing contents',()=>{
 const dir=mkdtempSync(join(tmpdir(),'synthetic-credential-'));try{const p=join(dir,'secrets.txt');writeFileSync(p,'project label: openai-api-key=test-placeholder\n');expect(loadProjectCredential(p)).toBe('test-placeholder');writeFileSync(p,'unrelated-private-value');expect(()=>loadProjectCredential(p)).toThrow('CREDENTIAL_UNAVAILABLE');}finally{rmSync(dir,{recursive:true});}
});
