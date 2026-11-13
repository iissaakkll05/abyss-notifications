const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=__dirname,fixture=path.join(root,'.browser-test.html');
fs.writeFileSync(fixture,fs.readFileSync(path.join(root,'browser.fixture.html'),'utf8').replace('/*BUNDLE*/',()=>fs.readFileSync(path.join(root,'main.js'),'utf8')).replace('/*STYLE*/',()=>fs.readFileSync(path.join(root,'styles.css'),'utf8')));
(async()=>{
 const {spawn}=require('node:child_process'),{pathToFileURL}=require('node:url'),profile=path.join(root,'.ui-profile'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const browser=spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',['--headless=new','--no-sandbox','--disable-gpu-sandbox','--in-process-gpu','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-extensions','--allow-file-access-from-files','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:'ignore',windowsHide:true});let ws;
 try{
  let port;for(let i=0;i<100;i++){try{port=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];const a=await fetch('http://127.0.0.1:'+port+'/json/list');if(a.ok)break;}catch{}await sleep(100);}
  const pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
  let id=0;const pending=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);const q=pending.get(m.id);if(q){pending.delete(m.id);m.error?q.reject(Error(m.error.message)):q.resolve(m.result)}};
  const send=(method,params={})=>new Promise((resolve,reject)=>{const i=++id;pending.set(i,{resolve,reject});ws.send(JSON.stringify({id:i,method,params}));});
  for(const [name,width,height,hash]of [['phone',390,844,'phone'],['desktop',1200,1000,'desktop']]){
   await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<650});
   await send('Page.navigate',{url:pathToFileURL(fixture).href+'?case='+name+'#'+hash});
   let value;for(let i=0;i<100;i++){await sleep(50);value=(await send('Runtime.evaluate',{expression:'JSON.stringify({result:document.body?.dataset.result,error:document.body?.dataset.error,width:innerWidth})',returnByValue:true})).result.value;if(JSON.parse(value||'{}').result)break;}
   const report=JSON.parse(value||'{}');assert.equal(report.result,'PASS',name+': '+JSON.stringify(report));assert.equal(report.width,width);
   const capture=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(root,'.browser-'+name+'.png'),Buffer.from(capture.data,'base64'));console.log('OK '+name+' renders without overflow at '+width+'px and verifies real XML discovery and one-way writes');
  }
  console.log('2 real-browser integration / UI checks passed');await send('Browser.close');
 }finally{ws?.close();browser.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
