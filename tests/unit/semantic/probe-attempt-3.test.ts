import {expect,test} from 'vitest';
import {mkdtempSync,readFileSync,existsSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareAttempt3,claimAttempt3,verifyAttempt3} from '../../semantic/probe-attempt-3.js';
test('attempt3 freezes unchanged model, 12 fixed cases and all semantic/oracle dependencies below budget',()=>{
 const freeze=prepareAttempt3();expect(freeze.model).toBe('gpt-4.1-2025-04-14');expect(freeze.attempt).toBe(3);expect(freeze.caseIds).toHaveLength(12);expect(new Set(freeze.caseIds).size).toBe(12);expect(freeze.maxUsd).toBe(2);expect(freeze.worstCaseUsd).toBeLessThan(2);
 expect(Object.keys(freeze.sourceHashes)).toContain('tests/semantic/temporal-oracle.ts');expect(Object.keys(freeze.sourceHashes)).toContain('src/modules/semantic/application/quote-grounding.ts');expect(Object.keys(freeze.sourceHashes)).toContain('src/modules/semantic/application/temporal-intent.ts');
 expect(()=>verifyAttempt3({...freeze,promptHash:'wrong'},freeze)).toThrow('ATTEMPT3_FREEZE_MISMATCH');
});
test('exclusive attempt3 claim cannot replay and does not touch historical markers',()=>{
 const dir=mkdtempSync(join(tmpdir(),'synthetic-attempt3-'));try{
 const old=join(dir,'old-started');writeFileSync(old,'preserved');const before=readFileSync(old,'utf8');
 const marker=join(dir,'attempt3-started');claimAttempt3(marker,'frozen-hash');expect(existsSync(marker)).toBe(true);expect(()=>claimAttempt3(marker,'frozen-hash')).toThrow();expect(readFileSync(old,'utf8')).toBe(before);
 }finally{rmSync(dir,{recursive:true});}
});
