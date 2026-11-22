import { buildInternalHeaders } from '../security/internalAuth.js';
import { boundedInt } from '../lib/config.js';
import { MAX_CANDIDATE_BYTES, uiError } from './contracts.js';

async function readLimited(response) {
  const reader=response.body?.getReader();
  if (!reader) return '';
  const chunks=[]; let total=0;
  try {
    for (;;) {
      const {value,done}=await reader.read(); if(done) break;
      total+=value.byteLength;
      if(total>MAX_CANDIDATE_BYTES+128*1024) { await reader.cancel(); throw uiError('UI_CALLBACK_RESPONSE_TOO_LARGE',502,false); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes=new Uint8Array(total); let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return new TextDecoder().decode(bytes);
}

export async function uiGatewayCall(env,stage,payload,{fetchImpl=null}={}) {
  const binding=env?.TEST_DESIGN_GENERATION_SERVICE;
  if(!fetchImpl&&!binding?.fetch) throw uiError('UI_GATEWAY_NOT_CONFIGURED',503,true);
  if(!['compile','publish'].includes(stage)) throw uiError('UI_CALLBACK_STAGE_INVALID');
  const url=`https://api.apiqagent.com/internal/v1/ui-test-design/${stage}`;
  const rawBody=JSON.stringify(payload);
  const headers=await buildInternalHeaders({env,method:'POST',url,organizationId:payload.organizationId,projectId:payload.projectId,rawBody});
  const leaseMs=boundedInt(env?.UI_ITEM_LEASE_SECONDS,240,180,600)*1000;
  const timeoutMs=Math.min(stage==='compile'?150000:60000,leaseMs-30000);
  const controller=new AbortController(); let timer;
  const request=new Request(url,{method:'POST',headers:{...headers,'content-type':'application/json',accept:'application/json'},body:rawBody,signal:controller.signal});
  try {
    const operation=(async()=>{
      const response=await (fetchImpl?fetchImpl(request):binding.fetch(request));
      const text=await readLimited(response); let body;
      try{body=JSON.parse(text);}catch{throw uiError('UI_CALLBACK_RESPONSE_INVALID',502,true);}
      if(!response.ok){
        const code=/^[A-Z][A-Z0-9_]{0,127}$/.test(body?.code||'')?body.code:'UI_GATEWAY_UPSTREAM_FAILED';
        const retryable=typeof body?.retryable==='boolean'?body.retryable:response.status===429||response.status>=500;
        throw uiError(code,response.status,retryable);
      }
      if(body?.status!=='ok'||!body.data) throw uiError('UI_CALLBACK_RESPONSE_INVALID',502,true);
      return body.data;
    })();
    return await Promise.race([operation,new Promise((_,reject)=>{
      timer=setTimeout(()=>{controller.abort();reject(uiError('UI_GATEWAY_TIMEOUT',504,true));},timeoutMs);
    })]);
  } catch(error) {
    if(error?.code) throw error;
    throw uiError('UI_GATEWAY_UNAVAILABLE',503,true);
  } finally { clearTimeout(timer); }
}
