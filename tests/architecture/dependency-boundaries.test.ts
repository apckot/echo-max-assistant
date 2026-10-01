import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';

const guard = resolve('scripts/check-architecture.mjs');
const roots: string[] = [];

function fixture(files: Record<string, string>, tsconfig?: object) {
  const root = mkdtempSync(join(tmpdir(), 'echo-boundaries-'));
  roots.push(root);
  for (const [path, source] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
  }
  if (tsconfig) writeFileSync(join(root, 'tsconfig.json'), JSON.stringify(tsconfig));
  return spawnSync(process.execPath, [guard], { cwd: root, encoding: 'utf8' });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test.each([
  ['value import', "import Fastify from 'fastify';", 'fastify'],
  ['type import', "import type { Pool } from 'pg';", 'pg'],
  ['type re-export', "export type { Pool } from 'pg';", 'pg'],
  ['dynamic import', "const driver = import('pg');", 'pg'],
  ['provider SDK', "import type { Client } from '@maxhub/max-bot-api';", '@maxhub/max-bot-api'],
])('rejects %s in application', (_label, source, dependency) => {
  const result = fixture({ 'src/modules/intake/application/use-case.ts': source });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('src/modules/intake/application/use-case.ts');
  expect(result.stderr).toContain(dependency);
});

test('rejects resolved infrastructure and HTTP DTO paths, including type-only aliases', () => {
  const result = fixture({
    'src/modules/intake/domain/event.ts': "import type { Event } from '../../../infrastructure/max/event-dto.js';",
    'src/modules/intake/application/use-case.ts': "import type { Request } from '@http/request-dto.js';",
    'src/infrastructure/max/event-dto.ts': 'export type Event = {};',
    'src/shared/http/request-dto.ts': 'export type Request = {};',
  }, { compilerOptions: { baseUrl: '.', paths: { '@http/*': ['src/shared/http/*'] }, module: 'NodeNext', moduleResolution: 'NodeNext' } });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('src/modules/intake/domain/event.ts');
  expect(result.stderr).toContain('src/infrastructure/max/event-dto.ts');
  expect(result.stderr).toContain('src/modules/intake/application/use-case.ts');
  expect(result.stderr).toContain('src/shared/http/request-dto.ts');
});

test('allows inward dependencies and does not scan adapter code', () => {
  const result = fixture({
    'src/modules/intake/domain/event.ts': "import type { Id } from '../../../shared/types.js';",
    'src/modules/intake/application/use-case.ts': "import type { Event } from '../domain/event.js';",
    'src/modules/intake/infrastructure/adapter.ts': "import type { Event } from '../domain/event.js'; import Fastify from 'fastify';",
    'src/shared/types.ts': 'export type Id = string;',
  });
  expect(result.status, result.stderr).toBe(0);
});

test('ignores comments and strings that merely mention forbidden imports', () => {
  const result = fixture({
    'src/modules/intake/domain/event.ts': "// import { Pool } from 'pg'\nconst example = \"import Fastify from 'fastify'\";",
  });
  expect(result.status, result.stderr).toBe(0);
});
