import { createHash } from 'node:crypto';
import { readdir,readFile } from 'node:fs/promises';
import type { Database } from './database.js';
import type { HealthSnapshot,HealthStore } from '../../modules/operations/application/health-service.js';
export async function expectedMigrations() {
  const directory=new URL('../../../migrations/',import.meta.url);
  const names=(await readdir(directory)).filter(name=>name.endsWith('.sql'));
  return Object.fromEntries(await Promise.all(names.map(async name=>
    [name,createHash('sha256').update(await readFile(new URL(name,directory))).digest('hex')])));
}
export class PostgresHealthStore implements HealthStore {
  constructor(private readonly database:Database) {}
  snapshot() { return this.database.systemTransaction('gateway',async tx=>{
    const rows=await tx.query<{snapshot:HealthSnapshot}>('SELECT public.component_health() AS snapshot');
    if(!rows[0]?.snapshot) throw new Error('health_unavailable');
    return rows[0].snapshot;
  }); }
}
