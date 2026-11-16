// Minimal LLM proxy: keeps the API key on the server. Node 18+.
// Run: OPENROUTER_API_KEY=... MODEL=anthropic/claude-sonnet-4.5 ALLOW_ORIGIN=https://your-app.example node proxy.js
const http=require('http');
const KEY=process.env.OPENROUTER_API_KEY,MODEL=process.env.MODEL,ORIGIN=process.env.ALLOW_ORIGIN||'http://localhost:8080',PORT=process.env.PORT||3100;
if(!KEY||!MODEL){console.error('Set OPENROUTER_API_KEY and MODEL');process.exit(1)}
const SYS=`You are a clinical informatics assistant. Return ONLY valid JSON (no prose, no markdown) for the diagnosis given: {"diagnosis":{"text","snomed":{"code","display"}},"sections":[{"title","fields":[{"id","label","type":"datetime|duration_min|number|integer|select|boolean|text","unit","options":[],"required":false,"rationale","coding":{"system":"snomed|loinc","code","display"},"fhir":{"resource","valueType"},"derived":{"from":[],"op":"minutes_between"}}]}]}. 8-14 fields. Prioritise time-critical intervals, severity, therapy, complications. If unsure of a code, leave it empty.`;
const hits={};
http.createServer(async(req,res)=>{
 const h={'Access-Control-Allow-Origin':ORIGIN,'Access-Control-Allow-Headers':'content-type','Access-Control-Allow-Methods':'POST,OPTIONS','Content-Type':'application/json'};
 if(req.method=='OPTIONS'){res.writeHead(204,h);return res.end()}
 const ip=req.socket.remoteAddress,m=Math.floor(Date.now()/6e4);hits[ip+m]=(hits[ip+m]||0)+1;
 if(hits[ip+m]>10){res.writeHead(429,h);return res.end('{"error":"rate limit"}')}
 let b='';for await(const c of req){b+=c;if(b.length>4000){res.writeHead(413,h);return res.end('{"error":"too large"}')}}
 try{const {prompt}=JSON.parse(b);if(typeof prompt!='string'||prompt.length>2000)throw Error('bad prompt');
  const r=await fetch('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',Authorization:'Bearer '+KEY},body:JSON.stringify({model:MODEL,max_tokens:3000,messages:[{role:'system',content:SYS},{role:'user',content:prompt}]})});
  const j=await r.json();if(!r.ok)throw Error(j.error?.message||'upstream '+r.status);
  res.writeHead(200,h);res.end(JSON.stringify({text:j.choices[0].message.content}))}
 catch(e){res.writeHead(400,h);res.end(JSON.stringify({error:e.message}))}
}).listen(PORT,()=>console.log('proxy on '+PORT));
