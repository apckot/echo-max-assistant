import { createHash,timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { HealthService } from '../../modules/operations/application/health-service.js';
export function registerHealthRoutes(app:FastifyInstance,service:HealthService,token?:string) {
  app.get('/health/live',async()=>({live:true}));
  app.get('/health/ready',async(_request,reply)=>{
    const health=await service.check();
    return reply.code(health.ready?200:503).send({ready:health.ready,subscription:'subscription' in health?health.subscription:{status:'unknown'}});
  });
  app.get('/ops/health',{onRequest:async(request,reply)=>{
    const candidate=request.headers.authorization;
    const hash=(value:string)=>createHash('sha256').update(value).digest();
    if(!token || typeof candidate!=='string' || !timingSafeEqual(hash(candidate),hash(`Bearer ${token}`)))
      return reply.code(401).send({code:'unauthorized'});
  }},async(_request,reply)=>{ const health=await service.check(); return reply.code('code' in health?503:200).send(health); });
}
