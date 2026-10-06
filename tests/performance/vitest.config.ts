import {defineConfig} from 'vitest/config';
export default defineConfig({test:{include:['tests/performance/*.run.ts'],maxWorkers:1,testTimeout:180_000}});
