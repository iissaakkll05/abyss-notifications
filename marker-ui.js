"use strict";
const markerPattern=()=>/<!-- (?:gcal|dav):[a-f0-9]{32} -->/g;
const selector='.abyss-calendar-item, .abyss-calendar-title, .abyss-calendar-preview-title';
const wrapperSelector='span.task-calendar-bridge-hidden-marker';
function wrapMarkerText(node){
  const text=node.nodeValue,pattern=markerPattern();let match,last=0,changed=false;
  const doc=node.ownerDocument,fragment=doc.createDocumentFragment();
  while((match=pattern.exec(text))){
    changed=true;
    if(match.index>last)fragment.appendChild(doc.createTextNode(text.slice(last,match.index)));
    const span=doc.createElement('span');span.className='task-calendar-bridge-hidden-marker';
    span.hidden=true;span.setAttribute('aria-hidden','true');span.style.display='none';
    span.textContent=match[0];fragment.appendChild(span);last=match.index+match[0].length;
  }
  if(!changed)return false;
  if(last<text.length)fragment.appendChild(doc.createTextNode(text.slice(last)));
  node.replaceWith(fragment);return true;
}
function installAbyssMarkerHider(owner,doc){
  if(!doc?.body||typeof MutationObserver==='undefined')return ()=>{};
  let stopped=false;
  function restore(){
    for(const span of doc.querySelectorAll(wrapperSelector))span.replaceWith(doc.createTextNode(span.textContent));
  }
  function clean(root){
    if(stopped||!owner.settings.hideMarkers)return;
    // Only presentation nodes in the Abyss calendar; never editors, task data,
    // source notes, event handlers, or the Abyss plugin's files/settings.
    const walker=doc.createTreeWalker(root,4),nodes=[];let node;
    while((node=walker.nextNode())){
      const parent=node.parentElement;
      if(parent&&!parent.closest(wrapperSelector)&&!parent.closest('input,textarea,[contenteditable="true"],.cm-editor')&&markerPattern().test(node.nodeValue))nodes.push(node);
    }
    for(const text of nodes)wrapMarkerText(text);
  }
  function scan(node){
    if(!owner.settings.hideMarkers)return;
    const element=node.nodeType===1?node:node.parentElement;
    if(!element)return;
    const parent=element.closest(selector);
    if(parent)clean(parent);
    else for(const root of element.querySelectorAll(selector))clean(root);
  }
  const observer=new MutationObserver(records=>{
    for(const record of records){
      if(record.type==='characterData')scan(record.target);
      else for(const node of record.addedNodes)scan(node);
    }
  });
  observer.observe(doc.body,{subtree:true,childList:true,characterData:true});
  scan(doc.body);
  const refresh=()=>{if(owner.settings.hideMarkers)scan(doc.body);else restore();};
  owner.refreshAbyssMarkers=refresh;
  return ()=>{stopped=true;observer.disconnect();restore();if(owner.refreshAbyssMarkers===refresh)delete owner.refreshAbyssMarkers;};
}
module.exports={installAbyssMarkerHider,wrapMarkerText};
