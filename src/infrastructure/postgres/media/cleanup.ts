import type {Database} from '../database.js';
export class MediaCleanup {
 constructor(private readonly database:Database){}
 run(limit=100){if(!Number.isInteger(limit)||limit<1||limit>100)throw Error('MEDIA_CLEANUP_LIMIT');return this.database.systemTransaction('scheduler',async tx=>{
  await tx.query('SELECT public.expire_media_preparations($1)',[limit]);await tx.query('SELECT public.cleanup_media_metadata($1)',[limit]);
 });}
}
