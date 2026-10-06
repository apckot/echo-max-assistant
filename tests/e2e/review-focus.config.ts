import {defineConfig} from 'vitest/config';
// Reuse the actual regression suites; avoid wrappers that run the same tests twice in the full gate.
export default defineConfig({test:{maxWorkers:1,include:[
 'tests/e2e/foundation-flow.test.ts',
 'tests/functional/runtime/checkpoint.test.ts', // duplicate, post-commit durability, uncertain timeout
 'tests/functional/runtime/worker.test.ts', // blocked head -> terminal continuation, parallel conversations
 'tests/functional/intake/queue-fencing.test.ts', // stale worker authority
 'tests/functional/operations/restore-fence.test.ts', // snapshot replay prevention
]}});
