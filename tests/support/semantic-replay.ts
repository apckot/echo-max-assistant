/** Offline projection of historical wire-v1 evidence only. Never repairs semantic fields, labels or relationships. */
export function projectLegacyQuotes(value:unknown):unknown{
 const walk=(v:unknown):unknown=>{if(Array.isArray(v))return v.map(walk);if(!v||typeof v!=='object')return v;
  const o=v as Record<string,unknown>;
  if(typeof o.sourceLabel==='string'&&typeof o.quote==='string')return {sourceLabel:o.sourceLabel,quote:o.quote};
  return Object.fromEntries(Object.entries(o).map(([k,x])=>[k,walk(x)]));};
 return {...walk(value) as Record<string,unknown>,version:2};
}
