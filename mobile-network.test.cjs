const assert=require('node:assert/strict'),{createDavRequest}=require('./mobile-network');
(async()=>{
 const seen=[],native=async p=>{seen.push(p);return {status:207,text:'OK'};};assert.equal(createDavRequest(native,{ios:false}),native);console.log('OK desktop uses original transport function unchanged');
 const ios=createDavRequest(native,{ios:true}),body='<task>Привет ⏰</task>',params={url:'https://dav.fruux.com/',method:'PROPFIND',headers:{Authorization:'Basic private-test',Depth:'0'},contentType:'application/xml; charset=utf-8',body,throw:false};
 await ios(params);const p=seen[0];assert.ok(p.body instanceof ArrayBuffer);assert.equal(new TextDecoder().decode(p.body),body);assert.equal(p.headers.authorization,params.headers.Authorization);assert.equal(p.headers.depth,'0');assert.equal(p.headers['content-type'],params.contentType);assert.equal(params.body,body);assert.equal(params.headers.Authorization,'Basic private-test');console.log('OK iOS sends exact UTF-8 bytes with headers and credentials preserved, without mutating input');
 await ios({url:params.url,method:'GET'});assert.equal(seen[1].body,undefined);assert.equal(seen[1].headers.authorization,undefined);console.log('OK unauthenticated diagnostic GET never acquires password or request body');
 let finish,calls=0;const delayed=new Promise(r=>{finish=r;}),bounded=createDavRequest(async()=>{calls++;return delayed;},{ios:true,timeoutMs:5});
 await assert.rejects(()=>bounded({...params,method:'PUT'}),e=>e.code==='DAV_TIMEOUT');assert.equal(calls,1);
 await assert.rejects(()=>bounded({url:params.url,method:'GET'}),e=>e.code==='DAV_IN_FLIGHT');assert.equal(calls,1);
 finish({status:201});await new Promise(r=>setImmediate(r));await bounded({url:params.url,method:'GET'});assert.equal(calls,2);console.log('OK hung iOS request times out; no further requests or duplicate writes until native operation settles');
})().catch(e=>{console.error(e);process.exitCode=1;});
