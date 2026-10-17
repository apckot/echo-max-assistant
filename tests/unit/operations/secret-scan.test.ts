import {test,expect} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
test('secret exception is exact value AND exact test path; similar unissued key and other path still detected',()=>{
 const root=mkdtempSync(join(tmpdir(),'echo-secret-guard-'));try{
 mkdirSync(join(root,'tests/functional/privacy'),{recursive:true});mkdirSync(join(root,'proof'));
 const assignment='api'+'_key=';const fake='synthetic'+'-forbidden';
 writeFileSync(join(root,'tests/functional/privacy/egress-contract.test.ts'),"const secret='"+assignment+fake+"';\nconst secret='"+'sk'+'-proj-'+randomBytes(32).toString('hex')+"';\n");
 writeFileSync(join(root,'other.ts'),"const secret='"+assignment+fake+"';\n");
 const result=spawnSync('docker',['run','--rm','--network','none','-v',root+':/repo','-v',resolve('.gitleaks.toml')+':/policy.toml:ro','ghcr.io/gitleaks/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f','dir','/repo','--config','/policy.toml','--redact=100','--report-format=json','--report-path=/repo/proof/report.json'],{encoding:'utf8'});
 expect(result.status).toBe(1);const rows=JSON.parse(readFileSync(join(root,'proof/report.json'),'utf8'));
 expect(rows.map((r:any)=>[r.File.replace('/repo/',''),r.StartLine]).sort()).toEqual([['other.ts',1],['tests/functional/privacy/egress-contract.test.ts',2]].sort());
 }finally{rmSync(root,{recursive:true,force:true});}
},30000);
