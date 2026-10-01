import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { test, expect } from 'vitest';

test('the package builds an importable ESM entrypoint', async () => {
  const build = spawnSync('npm', ['run', 'build'], { encoding: 'utf8' });

  expect(build.status, build.stderr || build.stdout).toBe(0);
  expect(existsSync(new URL('../../dist/index.js', import.meta.url))).toBe(true);
  await expect(import('../../dist/index.js')).resolves.toBeDefined();
});
