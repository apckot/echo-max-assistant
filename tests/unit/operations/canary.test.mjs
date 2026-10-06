import {expect,test} from 'vitest';
import {preflight} from '../../../ops/canary/preflight.mjs';
test('canary stops without dedicated test credentials/recipient and never exposes values',()=>{
 const value=preflight({MAX_BOT_TOKEN:'private-token'});expect(value.ready).toBe(false);
 expect(value.missing).toContain('MAX_CANARY_TEST_CONFIRMED');expect(JSON.stringify(value)).not.toContain('private-token');
});
test('safe canary requires explicit TEST confirmation, exact recipient and HTTPS webhook',()=>{
 const env={MAX_BOT_TOKEN:'test-token',MAX_WEBHOOK_SECRET:'test-secret',MAX_WEBHOOK_SECRET_VERSION:'v1',MAX_WEBHOOK_URL:'https://example.org/hook',MAX_CANARY_TEST_CONFIRMED:'true',MAX_CANARY_TEST_USER_ID:'123'};
 expect(preflight(env)).toEqual({ready:true,missing:[]});
 expect(preflight({...env,MAX_WEBHOOK_URL:'http://example.org/hook'}).ready).toBe(false);
 expect(preflight({...env,MAX_CANARY_TEST_USER_ID:''}).ready).toBe(false);
});
