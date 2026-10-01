import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, expect } from 'vitest';

const repo = fileURLToPath(new URL('../..', import.meta.url));

test('Git ignores local env files while retaining the tracked template', () => {
  for (const path of ['.env', '.env.local', 'nested/.env', 'nested/.env.production']) {
    const result = spawnSync('git', ['check-ignore', '--no-index', '-q', '--', path], { cwd: repo });
    expect(result.status, `${path}: ${result.stderr.toString()}`).toBe(0);
  }

  for (const path of ['.env.example', 'nested/.env.example']) {
    const result = spawnSync('git', ['check-ignore', '--no-index', '-q', '--', path], { cwd: repo });
    expect(result.status, `${path}: ${result.stderr.toString()}`).toBe(1);
  }

  const template = spawnSync('git', ['ls-files', '--error-unmatch', '--', '.env.example'], { cwd: repo });
  expect(template.status, template.stderr.toString()).toBe(0);
});
