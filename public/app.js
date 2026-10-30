import {timeline,timelineDuration,activeAt,transitionTypes,speedOf,sourceOut,normalizeTransitions,splitAt,trimEdge} from './timeline.js';
import {saveProjectFile,importProjectFile,createNewProject} from './project-io.js';
const $ = s => document.querySelector(s);
const esc = s => String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = () => crypto.randomUUID();
const icons = {
  media:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m3 15 5-5 5 5 3-3 5 5"/><circle cx="16" cy="8" r="1"/>',
  audio:'<path d="M9 18V5l12-2v13M9 8l12-2"/><ellipse cx="6" cy="18" rx="3" ry="2"/><ellipse cx="18" cy="16" rx="3" ry="2"/>',
  export:'<path d="M12 15V3m-4 4 4-4 4 4M4 14v6h16v-6"/>',
  film:'<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18M17 3v18M3 8h4m10 0h4M3 16h4m10 0h4"/>',
};
const icon = name=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${icons[name]}</svg>`;
let projectServerRevision=null;
let project, assets=[], jobs=[], engine=false, selected=null, filter='all', query='', position=0, playing=false, captions=true, zoom=24;
let undo=[],redo=[],saveTimer,saving=Promise.resolve(),revision=0,savedRevision=0,uploading=false,clockStart=0,startPosition=0,raf,poll;
let snapping=true,dragEdit=null,suppressClick=false;
let speechConfigId='reference',dialogueLines=[{characterId:'',text:'',start:'',duration:''}],speechMode='single';
let speechDraft={text:'',provider:'gpt-sovits',voice:null,speed:.95,preset:'natural',category:'child',target:'child',style:'neutral'},speechProviders=[],speechCatalog=null,speechResult=null,speechPoll,speechBusy=false,sovitsStatus={configured:false,endpoint:'http://127.0.0.1:9880',referenceAudio:null,promptText:'',ageGroup:'child'};
const asset = id=>assets.find(a=>a.id===id);
const total = ()=>timelineDuration(project);
const current = ()=>project.clips.find(c=>c.id===selected);
const time = seconds=>{const n=Math.floor(Math.max(0,seconds));return `${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`;};
const precise = seconds=>`${time(seconds)}:${String(Math.floor((Math.max(0,seconds)%1)*project.fps+0.00001)).padStart(2,'0')}`;
async function api(url,options={}) {
  const res=await fetch(url,options);const data=await res.json();if(!res.ok)throw new Error(data.error||'请求失败');if(res.headers.get('ETag'))projectServerRevision=res.headers.get('ETag');return data;
}
const send = (url,data,method='POST')=>api(url,{method,headers:{'Content-Type':'application/json',...(['/api/project','/api/arrange'].includes(url)&&projectServerRevision?{'If-Match':projectServerRevision}:{})},body:JSON.stringify(data)});
function toast(message){$('#toast').textContent=message;$('#toast').classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').classList.remove('show'),5000);}
function dirty(){revision++;$('#save-state').textContent='等待保存';clearTimeout(saveTimer);saveTimer=setTimeout(()=>save().catch(e=>toast(e.message)),700);}
function save(){
  clearTimeout(saveTimer);const data=structuredClone(project), rev=revision;
  saving=saving.catch(()=>{}).then(async()=>{
    $('#save-state').textContent='保存中…';
    try{await send('/api/project',data,'PUT');savedRevision=rev;$('#save-state').textContent=revision===rev?'已保存到本机':'等待保存';}
    catch(e){$('#save-state').textContent='保存失败 · 请修正';throw e;}
  });return saving;
}
const snapshot=()=>({project:structuredClone(project),selected,position});
function restore(state){project=state.project;selected=project.clips.some(c=>c.id===state.selected)?state.selected:project.clips[0]?.id;position=Math.min(state.position,total());}
function history(){undo.push(snapshot());if(undo.length>50)undo.shift();redo=[];}
function change(fn){pause();const before=snapshot();try{fn();normalizeTransitions(project);}catch(e){restore(before);toast(e.message);return false;}undo.push(before);if(undo.length>50)undo.shift();redo=[];position=Math.min(position,total());dirty();render();return true;}
function clipStart(id){return timeline(project).find(item=>item.clip.id===id)?.start??0;}
function select(id){pause();selected=id;position=clipStart(id);render();}

function seek(value){pause();position=Math.round(Math.max(0,Math.min(total(),value))*project.fps)/project.fps;updatePreview();updateTransport();}
function editClip(key,value){
  const c=current();if(!c||c.locked&&key!=='locked')return;
  let next={...c};
  if(key==='speed'){
    const speed=Number(value);if(!Number.isFinite(speed)||speed<.25||speed>4)return toast('视频倍速范围为 0.25 至 4');
    next.duration=Math.floor(c.duration*speedOf(c)/speed*project.fps+1e-7)/project.fps;next.speed=speed;
  }else if(key==='sourceOut')next.duration=Math.floor((Number(value)-c.sourceIn)/speedOf(c)*project.fps+1e-7)/project.fps;
  else if(key==='sourceIn'){
    next.sourceIn=Number(value);next.duration=Math.floor((sourceOut(c)-next.sourceIn)/speedOf(c)*project.fps+1e-7)/project.fps;
  }else if(key==='assetId'){
    next.assetId=value;next.sourceIn=0;if(asset(value)?.type==='image')next.speed=1;
  }else next[key]=value;
  next.duration=Math.round(next.duration*project.fps)/project.fps;
  const a=asset(next.assetId);
  if(!a||!Number.isFinite(next.duration)||next.duration<1/project.fps||next.duration>3600||!Number.isFinite(next.sourceIn)||next.sourceIn<0||a.type==='image'&&speedOf(next)!==1||a.type==='video'&&sourceOut(next)>a.duration+.0001){toast('截取范围或倍速无效：至少保留一帧，且不能超出源素材。');renderInspector();return;}
  change(()=>Object.assign(c,next));
}
function setTransition(type,duration){
  const c=current(),i=project.clips.indexOf(c),next=project.clips[i+1];
  if(!c||!next||c.locked||next.locked)return toast('请先解锁接缝两侧镜头');
  if(type&&!transitionTypes[type])return;
  const max=Math.min(5,Math.floor(c.duration*project.fps/2)/project.fps,Math.floor(next.duration*project.fps/2)/project.fps);
  if(type&&max<1/project.fps)return toast('两侧镜头至少需要两帧才能添加转场');
  const d=Number(duration??c.transition?.duration??.4);
  if(type&&(!Number.isFinite(d)||d<1/project.fps||d>5))return toast('转场时长应在一帧至 5 秒之间');
  change(()=>c.transition=type?{type,duration:Math.min(d,max)}:null);
}
function trimToPlayhead(edge){
  const c=current(),item=timeline(project).find(i=>i.clip.id===c?.id);
  if(!item||c.locked)return toast('请先选择并解锁镜头');
  if(position<=item.start||position>=item.end)return toast('将播放头移到选中镜头内部再截取');
  change(()=>trimEdge(project,c.id,edge,edge==='in'?position-item.start:position-item.end,asset(c.assetId)));
}
function insertionForm(){
  pause();const d=$('#export-dialog');delete d.dataset.speech;delete d.dataset.job;
  const visual=assets.filter(a=>a.type!=='audio');
  d.innerHTML=`<h2>插入画面</h2><p>将图片作为过渡画面，或插入已有视频。在镜头中间插入会自动分割原镜头。</p>${visual.length?`<div class="field"><label for="insert-asset">画面素材</label><select id="insert-asset">${visual.map(a=>`<option value="${a.id}">${esc(a.name)}${a.type==='image'?' · 图片':' · 视频'}</option>`).join('')}</select></div><div class="field-row"><div class="field"><label for="insert-duration">停留时长（秒）</label><input id="insert-duration" type="number" min="${1/project.fps}" max="3600" step="${1/project.fps}" value="2"></div><div class="field"><label for="insert-position">插入位置</label><select id="insert-position"><option value="playhead">播放头 ${precise(position)}</option><option value="after" ${current()?'':'disabled'}>选中镜头之后</option><option value="end">成片末尾</option></select></div></div><div class="hint">插入后可在两侧接缝添加转场，或继续截取、变速。</div>`:'<div class="empty-inspector">素材库中还没有画面，请先导入视频或图片。</div>'}<div class="dialog-actions"><button data-action="close-dialog">取消</button>${visual.length?'<button class="primary" data-action="insert-confirm">插入画面</button>':'<button class="primary" data-action="upload">导入素材</button>'}</div>`;d.showModal();
}
function insertVisual(){
  const a=asset($('#insert-asset').value),duration=Math.round(Number($('#insert-duration').value)*project.fps)/project.fps,mode=$('#insert-position').value;
  if(!Number.isFinite(duration)||duration<1/project.fps||duration>3600||a.type==='video'&&duration>a.duration)return toast('插入时长无效，不能超出视频长度');
  const ok=change(()=>{
    let index=project.clips.length;
    if(mode==='after'){
      const c=current();if(c?.locked)throw new Error('请先解锁选中镜头');index=project.clips.indexOf(c)+1;if(c)c.transition=null;
    }
    if(mode==='playhead'&&position<total()){
      const item=activeAt(project,position);
      if(item){
        if(item.clip.locked||item.previous)throw new Error('请将播放头移至未锁定镜头的非转场区间');
        if(Math.round((position-item.start)*project.fps)>0){const right=splitAt(project,item.clip.id,position,uid());index=project.clips.indexOf(right);}
        else index=item.index;
        if(project.clips[index-1])project.clips[index-1].transition=null;
      }
    }
    const c={id:uid(),assetId:a.id,title:a.name.replace(/\.[^.]+$/,''),duration,sourceIn:0,speed:1,transition:null,subtitle:'',muted:true,locked:false};
    project.clips.splice(index,0,c);selected=c.id;position=clipStart(c.id);
  });
  if(ok){$('#export-dialog').close();toast('画面已插入，可在接缝处添加转场');}
}

function render(){
  const scroll=$('#timeline-scroll')?.scrollLeft||0, inspectorScroll=$('.inspector')?.scrollTop||0;
  $('#app').innerHTML=`<main class="shell">
    <header class="top"><div class="brand"><span class="brand-mark">c</span>CutPot</div><div class="divider"></div>
      <input class="project-name" id="project-name" aria-label="项目名称" value="${esc(project.name)}"><span class="save-state" id="save-state">${revision===savedRevision?'已保存到本机':'等待保存'}</span>
      <nav class="pipeline-nav" aria-label="创作流水线"><a href="/storyboard">01 分镜图</a><a href="/videos">02 首尾帧视频</a><a href="/editor" aria-current="page">03 剪辑导出</a></nav><div class="spacer"></div><span class="local-badge">本地工作台 · ${engine?'渲染引擎就绪':'未检测到 FFmpeg'}</span>
      <div class="project-file-actions" role="group" aria-label="工程文件"><button class="small" data-action="new-project">新增项目</button><button class="small" data-action="download-project">保存工程</button><button class="small" data-action="open-project">导入工程</button></div>
      <button class="primary" data-action="export">导出视频 ↗</button></header>
    <nav class="rail" aria-label="工作区"><button class="nav-item ${filter!=='audio'?'active':''}" data-action="nav-media">${icon('media')}素材</button><button class="nav-item ${filter==='audio'?'active':''}" data-action="nav-audio">${icon('audio')}声音</button><button class="nav-item" data-action="tts">${icon('audio')}自动配音</button><button class="nav-item" data-action="jobs">${icon('export')}导出</button><div class="rail-bottom">v0.9</div></nav>
    <aside class="library" id="drop-zone"><div class="panel-head"><h2>素材库 <span class="count">${assets.length}</span></h2><button class="ghost small" data-action="upload">＋ 导入</button></div>
      <div class="library-tools"><input id="search" placeholder="搜索素材名称…" aria-label="搜索素材" value="${esc(query)}"><div class="library-tabs">${[['all','全部'],['video','视频'],['image','图片'],['audio','音频']].map(([id,name])=>`<button class="filter ${filter===id?'active':''}" data-filter="${id}">${name}</button>`).join('')}</div></div>
      <div class="asset-list" id="asset-list"></div><div class="library-foot"><button class="small ghost" data-action="demo">载入乐乐示例</button><button class="small ghost" data-action="new-project">新增项目</button></div></aside>
    <section class="preview-panel"><div class="preview-head"><span>成片预览 <span id="preview-shot" class="muted"></span></span><span class="tag">${project.width} × ${project.height} · ${project.fps} FPS</span></div><div class="stage-wrap"><div class="stage" id="stage"></div></div>
      <div class="preview-transport"><div class="time-display" id="time-display"></div><div class="play-controls"><button data-action="previous" aria-label="上一个镜头">‹</button><button class="play" data-action="play" id="play" aria-label="播放或暂停">▶</button><button data-action="next" aria-label="下一个镜头">›</button></div><button class="ghost small caption-toggle" data-action="captions">字幕预览 ${captions?'开':'关'}</button></div>
      <audio id="voice-audio" preload="metadata"></audio><audio id="music-audio" preload="metadata" loop></audio></section>
    <aside class="inspector"><div class="panel-head"><h2>镜头编辑</h2><small>INSPECTOR</small></div><div id="inspector-body" class="inspector-body"></div></aside>
    <section class="timeline"><div class="timeline-toolbar"><h2>时间轴</h2><div class="tool-group"><button class="ghost small" data-action="undo" aria-label="撤销" title="撤销 ⌘Z" ${undo.length?'':'disabled'}>↶</button><button class="ghost small" data-action="redo" aria-label="重做" title="重做 ⇧⌘Z" ${redo.length?'':'disabled'}>↷</button></div><span class="divider"></span><div class="tool-group"><button class="small" data-action="split" title="在播放头处分割 S / ⌘B" ${!current()||current().locked?'disabled':''}>${icon('film')} 分割 <kbd>S</kbd></button><button class="ghost small" data-action="trim-in" title="删除播放头之前的部分 I" ${!current()||current().locked?'disabled':''}>设为入点 <kbd>I</kbd></button><button class="ghost small" data-action="trim-out" title="删除播放头之后的部分 O" ${!current()||current().locked?'disabled':''}>设为出点 <kbd>O</kbd></button></div><span class="divider"></span><button class="ghost small" data-action="insert">＋ 插入画面</button><button class="ghost small" data-action="duplicate" ${!current()||current().locked?'disabled':''}>复制</button><button class="ghost small" data-action="remove" ${!current()||current().locked?'disabled':''}>删除</button><div class="spacer"></div><button class="ghost small ${snapping?'is-on':''}" data-action="snap" aria-pressed="${snapping}" title="吸附到接缝和播放头 N">吸附 ${snapping?'开':'关'}</button><button class="ghost small" data-action="fit" title="完整显示时间轴">适应</button><label class="zoom-control"><span>−</span><input type="range" min="4" max="160" value="${zoom}" id="zoom" aria-label="时间轴缩放"><span>＋</span></label></div><div class="timeline-summary"><span class="timeline-mode">自动衔接</span><span id="timeline-summary">${project.clips.length} 个镜头 · ${precise(total())}</span><div class="spacer"></div><button class="ghost small" data-action="arrange">按分镜编号编排</button><span>拖动边缘截取 · 拖动片段排序</span></div><div class="timeline-scroll" id="timeline-scroll"></div>
      <footer class="status-bar"><span id="edit-feedback">裁剪与倍速调整后，后续镜头自动跟随</span><div class="spacer"></div><span>空格 播放</span><span>← → 逐帧</span><span>⌘ Z 撤销</span><button class="ghost small" data-action="shortcuts" aria-label="查看快捷键">快捷键 ?</button></footer></section></main>`;
  renderAssets();renderInspector();renderTimeline();updatePreview(true);updateTransport();setupAudio();bindDrop();
  $('#timeline-scroll').scrollLeft=scroll;$('.inspector').scrollTop=inspectorScroll;
}
function renderAssets(){
  const count=$('.library .count');if(count)count.textContent=assets.length;
  const list=assets.filter(a=>(filter==='all'||a.type===filter)&&a.name.toLowerCase().includes(query.toLowerCase()));
  $('#asset-list').innerHTML=list.length?list.map(a=>`<div class="asset">${a.thumbnail?`<img class="asset-thumb" src="${a.thumbnail}" alt="">`:'<div class="asset-thumb audio-thumb">♫</div>'}<div class="asset-info"><div class="asset-name" title="${esc(a.name)}">${esc(a.name)}</div><small>${a.type==='image'?`${a.width} × ${a.height}`:`${time(a.duration)} · ${a.type==='audio'?'音频':`${a.width} × ${a.height}`}`}</small></div><button class="asset-add" data-add="${a.id}" aria-label="添加 ${esc(a.name)}">＋</button></div>`).join(''):`<div class="empty-library">${assets.length?'没有符合条件的素材。':'将 AI 视频、图片或声音拖入这里。<br>支持批量导入，单文件最多 1 GB。<br><br>也可载入现有乐乐分镜，立即体验 60 秒组片。'}</div>`;
}
function renderInspector(){
  const c=current(), a=c?asset(c.assetId):null, item=timeline(project).find(i=>i.clip.id===c?.id), next=item?project.clips[item.index+1]:null;
  $('#inspector-body').innerHTML=`${c&&a?`<div class="clip-heading"><div class="clip-number">镜头 ${String(project.clips.indexOf(c)+1).padStart(2,'0')}</div><span class="tag">${a.type==='image'?'静态画面':`${speedOf(c)}×`}</span></div><div class="field"><label for="clip-title">镜头名称</label><input id="clip-title" data-field="title" value="${esc(c.title)}"></div>
    <div class="edit-section"><div class="edit-section-head"><h3>截取范围</h3><span>源素材时间 · 秒</span></div><div class="field-row"><div class="field"><label for="source-in">入点</label><input id="source-in" type="number" min="0" step="0.01" data-field="sourceIn" value="${Number(c.sourceIn.toFixed(4))}" ${a.type==='image'?'disabled':''}></div><div class="field"><label for="source-out">出点</label><input id="source-out" type="number" min="0" step="0.01" data-field="sourceOut" value="${Number(sourceOut(c).toFixed(4))}" ${a.type==='image'?'disabled':''}></div></div><div class="field"><label for="clip-duration">时间轴时长（秒）</label><input id="clip-duration" type="number" min="${1/project.fps}" max="3600" step="${1/project.fps}" data-field="duration" value="${c.duration}"></div><div class="clip-metrics"><span>源范围 ${Math.max(0,sourceOut(c)-c.sourceIn).toFixed(2)}s</span><strong>成片 ${c.duration.toFixed(2)}s</strong></div><div class="hint">${a.type==='video'?`素材共 ${a.duration.toFixed(2)} 秒。拖动时间轴两端也可截取。`:'静态画面可拖动右端调整停留时长。'}</div><div class="field-row trim-actions"><button class="small ghost" data-action="trim-in" ${c.locked?'disabled':''}>入点设到播放头</button><button class="small ghost" data-action="trim-out" ${c.locked?'disabled':''}>出点设到播放头</button></div></div>
    <div class="edit-section"><div class="edit-section-head"><h3>播放速度</h3><span>保留声音音高</span></div><label for="clip-speed" class="sr-only">播放倍速</label><input id="clip-speed" type="number" min="0.25" max="4" step="0.05" data-field="speed" value="${speedOf(c)}" ${a.type==='image'?'disabled':''}><div class="speed-presets">${[.25,.5,1,1.5,2,4].map(n=>`<button class="small ${speedOf(c)===n?'is-on':'ghost'}" data-speed="${n}" ${a.type==='image'||c.locked?'disabled':''}>${n}×</button>`).join('')}</div><div class="hint">${a.type==='image'?'静态画面通过时长控制停留。':'固定源素材入出点，倍速改变成片时长；按输出帧率对齐。'}</div></div>
    <div class="edit-section" id="transition-settings"><div class="edit-section-head"><h3>接缝转场</h3><span>${next?'至下一镜头':'片尾'}</span></div><div class="transition-options">${[['','硬切'],...Object.entries(transitionTypes)].map(([type,name])=>`<button class="small ${((c.transition?.type||'')===type)?'is-on':'ghost'}" data-transition="${type}" ${!next||c.locked||next.locked?'disabled':''}>${name}</button>`).join('')}</div>${next?`<div class="field"><label for="transition-duration">转场时长（秒）</label><input id="transition-duration" type="number" min="${1/project.fps}" max="${Math.min(5,Math.floor(c.duration*project.fps/2)/project.fps,Math.floor(next.duration*project.fps/2)/project.fps)}" step="${1/project.fps}" data-field="transitionDuration" value="${c.transition?.duration??.4}" ${!c.transition||next.locked?'disabled':''}></div><div class="hint">两侧画面重叠，成片相应缩短。最长为较短镜头的一半；点击时间轴接缝可编辑。</div>`:'<div class="hint">在两个相邻镜头之间添加转场。</div>'}</div>
    <div class="field"><label for="clip-asset">替换素材</label><select id="clip-asset" data-field="assetId">${assets.filter(x=>x.type!=='audio').map(x=>`<option value="${x.id}" ${x.id===a.id?'selected':''}>${esc(x.name)}</option>`).join('')}</select><div class="hint">保留镜头时长和字幕，源入点归零。</div></div>
    <label class="switch-row"><input type="checkbox" data-field="muted" ${c.muted?'checked':''} ${a.hasAudio?'':'disabled'}> 静音素材原声</label><label class="switch-row"><input type="checkbox" data-field="locked" ${c.locked?'checked':''}> 锁定镜头编辑与排序</label>
    <div class="field"><label for="clip-subtitle">镜头字幕</label><textarea id="clip-subtitle" rows="3" data-field="subtitle">${esc(c.subtitle)}</textarea></div><div class="field-row"><button class="small" data-action="move-left" ${c.locked?'disabled':''}>← 前移</button><button class="small" data-action="move-right" ${c.locked?'disabled':''}>后移 →</button></div>`:'<div class="empty-inspector">选中时间轴中的镜头，截取画面、调整倍速或添加转场。</div>'}
    <div class="section-label">项目输出</div><div class="field-row"><div class="field"><label for="resolution">画幅 / 分辨率</label><select id="resolution">${[[1920,1080,'1080p 横屏'],[1280,720,'720p 横屏'],[1080,1920,'1080p 竖屏']].map(([w,h,n])=>`<option value="${w},${h}" ${project.width===w&&project.height===h?'selected':''}>${n}</option>`).join('')}</select></div><div class="field"><label for="fps">帧率</label><select id="fps">${[24,25,30].map(v=>`<option ${project.fps===v?'selected':''}>${v}</option>`).join('')}</select></div></div>
    <div class="section-label">声音轨道</div>${['narration','music'].map(key=>`<div class="field"><label>${key==='narration'?'旁白（从成片开头播放）':'背景音乐（循环至结尾）'}</label><select data-audio="${key}" aria-label="${key==='narration'?'旁白素材':'背景音乐素材'}"><option value="">不使用</option>${assets.filter(x=>x.type==='audio').map(x=>`<option value="${x.id}" ${project[key]===x.id?'selected':''}>${esc(x.name)}</option>`).join('')}</select></div>`).join('')}
    ${project.narration&&asset(project.narration)?.duration>total()?'<div class="hint audio-warning">旁白长于成片，预览与导出会在成片结尾截断。</div>':''}<div class="field"><label for="music-volume">音乐音量 ${Math.round(project.musicVolume*100)}%</label><input type="range" min="0" max="1" step="0.01" value="${project.musicVolume}" id="music-volume"></div>`;
  if(c?.locked)$('#inspector-body').querySelectorAll('[data-field]:not([data-field="locked"]),[data-transition]').forEach(el=>el.disabled=true);
}
function renderTimeline(){
  const el=$('#timeline-scroll'), scroll=el.scrollLeft, items=timeline(project), width=Math.max(total()*zoom+48,el.clientWidth-90), step=zoom>=80?.5:zoom>=40?1:zoom>=16?5:10;
  let ticks='';for(let s=0;s<=width/zoom;s+=step)ticks+=`<span class="tick" style="left:${s*zoom}px">${step<1?s.toFixed(1):time(s)}</span>`;
  el.innerHTML=`<div class="timeline-content" style="width:${width+90}px"><div class="ruler" id="ruler" role="slider" tabindex="0" aria-label="播放头位置" aria-valuemin="0" aria-valuemax="${total()}" aria-valuenow="${position}" style="width:${width}px">${ticks}</div><div class="track-row video-row"><div class="track-label"><strong>V1</strong> 主画面</div><div class="clip-track" style="width:${width}px">${items.map(({clip:c,start})=>`<div role="button" tabindex="0" aria-pressed="${c.id===selected}" aria-label="${esc(c.title)}，${c.duration.toFixed(2)}秒，${speedOf(c)}倍速${c.locked?'，已锁定':''}" class="timeline-clip ${c.id===selected?'selected':''}" data-clip="${c.id}" draggable="${!c.locked}" style="left:${start*zoom}px;width:${c.duration*zoom}px">${asset(c.assetId)?.thumbnail?`<img draggable="false" src="${asset(c.assetId).thumbnail}" alt="">`:''}<span class="clip-meta">${c.locked?'锁定':speedOf(c)!==1?`${speedOf(c)}×`:''}</span><span class="clip-title">${esc(c.title)}</span><span class="clip-length">${c.duration.toFixed(2)}s</span>${!c.locked?`${asset(c.assetId)?.type==='video'?`<span class="trim-handle trim-left" data-trim="in" title="拖动截取入点"></span>`:''}<span class="trim-handle trim-right" data-trim="out" title="拖动截取出点"></span>`:''}</div>`).join('')}</div></div><div class="track-row transition-row"><div class="track-label">接缝转场</div><div class="transition-track" style="width:${width}px">${items.slice(0,-1).map(({clip:c,end,transition},i)=>`<button class="transition-joint ${transition?'has-transition':''}" data-joint="${c.id}" style="left:${(end-(transition?.duration||0)/2)*zoom}px;${transition?`width:${Math.max(24,transition.duration*zoom)}px;`:''}" aria-label="${esc(c.title)}与${esc(items[i+1].clip.title)}之间${transition?transitionTypes[transition.type]+' '+transition.duration+'秒':'添加转场'}" title="${transition?transitionTypes[transition.type]+' · '+transition.duration+'s':'添加接缝转场'}" ${c.locked||items[i+1].clip.locked?'disabled':''}>${transition?'⋈':'＋'}</button>`).join('')}</div></div>${['narration','music'].map((key,i)=>`<div class="track-row"><div class="track-label"><strong>A${i+1}</strong> ${i?'背景音乐':'旁白'}</div>${project[key]&&asset(project[key])?`<div class="audio-track ${i?'music':''}" style="width:${Math.min(total(),i?total():asset(project[key]).duration)*zoom}px">♫ ${esc(asset(project[key]).name)}</div>`:'<div class="track-placeholder">在右侧选择音频素材</div>'}</div>`).join('')}${items.length?'':`<div class="timeline-empty">导入素材后，点击素材旁的 ＋ 开始剪辑</div>`}<div class="playhead" id="playhead" style="left:${90+position*zoom}px" title="拖动播放头"><span class="playhead-grip"></span></div></div>`;
  el.scrollLeft=scroll;
  if($('#timeline-summary'))$('#timeline-summary').textContent=`${project.clips.length} 个镜头 · ${precise(total())}`;
}
let previewKey='';
function at(t){const item=activeAt(project,t);return item?{...item,c:item.clip}:null;}
function updatePreview(force=false){
  const item=at(position),stage=$('#stage');if(!stage)return;
  if(!item){stage.innerHTML=`<div class="stage-empty">${icon('film')}<strong>让零散镜头，成为完整故事</strong><p>导入视频或图片，在时间轴截取、分割和编排。</p><button class="primary" data-action="upload">＋ 导入素材</button> <button class="ghost" data-action="demo">体验乐乐示例 →</button></div>`;previewKey='';return;}
  const layers=item.previous?[item.previous,item]:[item], key=layers.map(i=>i.clip.id).join('/');
  stage.style.aspectRatio=`${project.width}/${project.height}`;
  if(force||previewKey!==key||!stage.querySelector('.preview-layer')){
    stage.innerHTML=layers.map(({clip:c},i)=>{const a=asset(c.assetId);return `<div class="preview-layer" data-layer="${i}">${a.type==='image'?`<img src="/api/assets/${a.id}/content" alt="${esc(c.title)}">`:`<video class="preview-video" src="/api/assets/${a.id}/content" playsinline preload="auto"></video>`}<div class="caption">${captions?esc(c.subtitle):''}</div></div>`;}).join('');
    previewKey=key;
    stage.querySelectorAll('video').forEach(video=>{
      video.addEventListener('loadedmetadata',()=>updatePreview(),{once:true});
      video.addEventListener('error',()=>{pause();toast('此视频格式无法在浏览器预览；可转为 MP4 后导入。');},{once:true});
    });
    stage.querySelectorAll('img').forEach(img=>img.addEventListener('error',()=>{const message=document.createElement('div');message.className='media-error';message.textContent='源图片无法读取，请在右侧替换素材';img.replaceWith(message);},{once:true}));
  }
  const p=item.previous?Math.max(0,Math.min(1,(position-item.start)/item.previous.transition.duration)):1,type=item.previous?.transition.type;
  stage.style.background=type==='fadewhite'?'#fff':'#000';
  layers.forEach(({clip:c,start},i)=>{
    const layer=stage.querySelector(`[data-layer="${i}"]`),incoming=i===1;
    layer.style.opacity=type==='dissolve'?(incoming?p:1):type==='fadeblack'||type==='fadewhite'?(incoming?Math.max(0,2*p-1):Math.max(0,1-2*p)):1;
    layer.style.clipPath=type==='wipeleft'&&incoming?`inset(0 0 0 ${(1-p)*100}%)`:'';
    const video=layer.querySelector('video'),offset=Math.min(sourceOut(c)-.001,c.sourceIn+Math.max(0,position-start)*speedOf(c));
    if(video){
      video.muted=c.muted;video.volume=item.previous?(incoming?p:1-p):1;video.playbackRate=speedOf(c);video.preservesPitch=true;
      if(video.readyState>=1&&Math.abs(video.currentTime-offset)>(playing?.16:.001))video.currentTime=Math.max(0,offset);
      if(playing&&video.paused)video.play().catch(()=>{});if(!playing&&!video.paused)video.pause();
    }
  });
  $('#preview-shot').textContent=` / ${String(item.index+1).padStart(2,'0')} · ${item.c.title}${item.previous?' · '+transitionTypes[type]:''}`;
}
function setupAudio(){for(const [key,id] of [['narration','voice-audio'],['music','music-audio']]){const el=$(`#${id}`);if(project[key]){el.src=`/api/assets/${project[key]}/content`;el.volume=key==='music'?project.musicVolume:1;}}}
function syncAudio(){for(const [key,id] of [['narration','voice-audio'],['music','music-audio']]){const el=$(`#${id}`);if(!project[key]||!el||!Number.isFinite(el.duration))continue;const t=key==='music'?position%el.duration:Math.min(position,el.duration);if(Math.abs(el.currentTime-t)>.25)el.currentTime=t;if(playing&&t<el.duration)el.play().catch(()=>{});}}
function updateTransport(){if(!$('#time-display'))return;$('#time-display').innerHTML=`${precise(position)} <span>/ ${precise(total())}</span>`;if($('#playhead'))$('#playhead').style.left=`${90+position*zoom}px`;$('#ruler')?.setAttribute('aria-valuenow',String(position));const scroll=$('#timeline-scroll'),x=90+position*zoom;if(playing&&scroll&&(x>scroll.scrollLeft+scroll.clientWidth-48||x<scroll.scrollLeft+90))scroll.scrollLeft=Math.max(0,x-120);$('#play').textContent=playing?'Ⅱ':'▶';}
function pause(){playing=false;cancelAnimationFrame(raf);document.querySelectorAll('.preview-video').forEach(video=>video.pause());$('#voice-audio')?.pause();$('#music-audio')?.pause();updateTransport();}
function play(){if(!project.clips.length)return;if(playing){pause();return;}if(position>=total()-.01)position=0;playing=true;clockStart=performance.now();startPosition=position;updatePreview(true);syncAudio();updateTransport();raf=requestAnimationFrame(tick);}
function tick(now){if(!playing)return;position=Math.min(total(),startPosition+(now-clockStart)/1000);updatePreview();syncAudio();updateTransport();if(position>=total()){pause();return;}raf=requestAnimationFrame(tick);}

async function upload(files){
  if(uploading)return toast('素材正在导入，请稍候');uploading=true;pause();let count=0;
  try{for(const file of files){toast(`正在导入 ${++count}/${files.length}：${file.name}`);const a=await api(`/api/assets/upload?name=${encodeURIComponent(file.name)}`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file});if(!asset(a.id))assets.push(a);}toast(`已导入 ${files.length} 个文件`);}
  catch(e){toast(`导入中止：${e.message}`);}finally{uploading=false;render();$('#files').value='';}
}
function add(id){const a=asset(id);if(a.type==='audio'){change(()=>project[project.narration?'music':'narration']=id);return;}
  change(()=>{const c={id:uid(),assetId:id,title:a.name.replace(/\.[^.]+$/,''),duration:a.type==='image'?3:Math.floor(Math.min(5,a.duration)*project.fps)/project.fps,sourceIn:0,subtitle:'',muted:true,locked:false};project.clips.push(c);selected=c.id;position=clipStart(c.id);});
}
function download(name,data){const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
async function showExport(){pause();const d=$('#export-dialog');delete d.dataset.speech;delete d.dataset.job;d.innerHTML=`<h2>导出完整视频</h2><p>按时间轴导出截取、倍速与接缝转场，原声保留音高并在转场处交叉淡化。可将镜头字幕直接显示在视频画面中，同时保留独立 SRT。</p><label class="field"><span><input id="burn-subtitles" type="checkbox" checked> 将字幕显示在视频画面中（烧录字幕）</span><span class="hint">底部居中、白字黑边；字幕按镜头区间显示。</span></label><div class="export-options"><div>H.264 / MP4<small>${project.width} × ${project.height} · ${project.fps} fps</small></div><div>${time(total())}<small>${project.clips.length} 个镜头 · AAC 音频</small></div></div><p>只在本机处理。导出结果保存在项目目录的 .cutpot/exports 中。</p><div class="dialog-actions"><button data-action="close-dialog">取消</button><button class="primary" data-action="start-export" ${!engine||!project.clips.length?'disabled':''}>开始导出 ↗</button></div>`;d.showModal();}
function jobView(job){
  const d=$('#export-dialog');d.innerHTML=`<h2>${job.status==='completed'?'视频已就绪':job.status==='failed'?'导出失败':job.status==='cancelled'?'已取消导出':'正在制作你的成片'}</h2><p>${esc(job.name)}</p><div class="progress-bar"><div class="progress-fill" style="width:${job.progress}%"></div></div><div class="job-message">${esc(job.message)}</div>${job.status==='completed'?`<div class="download-links"><a href="${job.output}" download="${esc(job.name)}.mp4">下载 MP4 ↗</a><a href="${job.srt}" download="${esc(job.name)}.srt">下载字幕 ↗</a></div>`:''}<div class="dialog-actions">${job.status==='running'?`<button data-cancel="${job.id}">取消任务</button>`:''}<button data-action="close-dialog">${job.status==='running'?'后台运行':'关闭'}</button></div>`;
}
async function monitor(id){clearInterval(poll);const refresh=async()=>{try{jobs=await api('/api/jobs');const j=jobs.find(x=>x.id===id);if(!j){clearInterval(poll);return;}if($('#export-dialog').open&&$('#export-dialog').dataset.job===id)jobView(j);if(j.status!=='running'){clearInterval(poll);toast(j.status==='completed'?'视频导出完成，可在导出面板下载。':j.message);}}catch(e){clearInterval(poll);toast(`导出状态连接中断：${e.message}`);}};poll=setInterval(refresh,1000);await refresh();}
function move(delta){const c=current(),i=project.clips.indexOf(c),target=i+delta;if(!c||c.locked||target<0||target>=project.clips.length||project.clips[target].locked)return toast('锁定镜头不能移动或被跨越');change(()=>{[project.clips[i],project.clips[target]]=[project.clips[target],c];position=clipStart(c.id);});}
function speechForm(error=''){
  if(speechMode==='dialogue')return speechDialogueForm(error);
  const d=$('#export-dialog');delete d.dataset.job;d.dataset.speech='form';
  const voices=[...(speechCatalog?.voices||[])].filter(v=>speechDraft.category!=='child'||v.ageGroup==='child').sort((a,b)=>Number(b.locale.startsWith('zh'))-Number(a.locale.startsWith('zh')));
  const native=speechDraft.target==='child',selectedVoice=voices.find(v=>v.id===speechDraft.voice),styles=['neutral',...(selectedVoice?.styles||[])];
  d.innerHTML=`<h2>自动配音</h2><div class="field"><label for="tts-mode">配音方式</label><select id="tts-mode"><option value="single">单角色配音</option><option value="dialogue">多角色台词</option></select></div><p>输入文案生成旁白，可试听、保存音频，或设为当前工程旁白。不会自动调整镜头时长。</p>
    <div class="field"><label for="tts-target">配音目标</label><select id="tts-target"><option value="child" ${native?'selected':''}>原生儿童声音 · 不使用成人变调</option><option value="general" ${!native?'selected':''}>通用语音</option></select></div>
    <div class="field-row"><div class="field"><label for="tts-provider">TTS 服务</label><select id="tts-provider">${speechProviders.map(p=>`<option value="${p.id}" ${speechDraft.provider===p.id?'selected':''} ${p.available&&(!native||p.id==='gpt-sovits')?'':'disabled'}>${esc(p.name)}${p.available?'':'（未配置或不可用）'}</option>`).join('')}</select></div><div class="field"><label for="tts-speed">语速倍率</label><select id="tts-speed">${[.5,.8,.95,1,1.2,1.5,2].map(n=>`<option value="${n}" ${speechDraft.speed===n?'selected':''}>${n} ×</option>`).join('')}</select></div></div>
    <div class="tts-config-status"><span>${sovitsStatus.configured?`GPT-SoVITS · ${esc(sovitsStatus.referenceName)}`:'GPT-SoVITS 尚未配置，请添加儿童参考录音'}</span><button class="small" data-action="tts-config">配置开源配音</button></div>
    <div class="field-row"><div class="field"><label for="tts-preset">声音处理</label><select id="tts-preset" ${native?'disabled':''}>${(speechCatalog?.presets||[{id:'natural',name:'原始音色'}]).filter(p=>!native||p.id==='natural').map(p=>`<option value="${p.id}" ${speechDraft.preset===p.id?'selected':''}>${native?'保留原生音色 · 不变调':esc(p.name)}</option>`).join('')}</select></div><div class="field"><label for="tts-category">音色筛选</label><select id="tts-category" ${native?'disabled':''}><option value="all" ${speechDraft.category==='all'?'selected':''}>全部音色</option><option value="child" ${speechDraft.category==='child'?'selected':''}>原生儿童音色</option></select></div></div>
    <div class="field"><label for="tts-voice">基础音色</label><select id="tts-voice" ${voices.length?'':'disabled'}>${voices.map(v=>`<option value="${esc(v.id)}" ${speechDraft.voice===v.id?'selected':''}>${esc(v.displayName??v.id)} · ${esc(v.locale)}</option>`).join('')}</select><div class="hint">${speechDraft.category==='child'&&!voices.length?'请先配置本机 GPT-SoVITS 和儿童参考录音。':native?'使用你确认的儿童原声参考录音生成，不进行升调。儿童分类由参考录音提供者确认。':'童声风格为基础音色的调音效果，不等同于原生儿童音色。'}</div></div>
    <div class="field"><label for="tts-style">说话方式</label><select id="tts-style" ${voices.length?'':'disabled'}>${styles.map(s=>`<option value="${esc(s)}" ${speechDraft.style===s?'selected':''}>${s==='neutral'?'原生语气':s==='chat'?'聊天 · 更口语化':esc(s)}</option>`).join('')}</select><div class="hint">${native?'自然语气由参考录音决定，建议选择清晰、有自然停顿的录音。':'说话风格仅在所选服务和音色明确支持时启用。'}</div></div>
    <div class="field"><label for="tts-text">配音文案（最多 10000 字符）</label><textarea id="tts-text" rows="5" maxlength="10000" placeholder="输入需要朗读的文案…">${esc(speechDraft.text)}</textarea></div>
    <div class="tts-disclosure">${speechDraft.provider==='edge'?'Edge 为在线语音：点击生成后，文案会发送到 Microsoft Edge 语音服务。失败不会切换其他服务。':speechDraft.provider==='gpt-sovits'?'使用本机 GPT-SoVITS：文案和参考录音交给本机推理服务，不需要云端密钥。实际音质取决于模型与参考录音。':'macOS 本地语音：文案在本机处理，不发送到在线语音服务。'}</div>
    ${error?`<p class="danger-text" role="alert">${esc(error)}</p>`:''}
    <div class="dialog-actions"><button class="ghost small" data-action="tts-use-subtitle" ${current()?.subtitle?'':'disabled'}>使用当前镜头字幕</button><button data-action="close-dialog">关闭</button><button class="primary" data-action="tts-generate" ${voices.length&&!speechBusy?'':'disabled'}>生成配音 ↗</button></div>`;
}
function speechDialogueForm(error=''){
  const d=$('#export-dialog');delete d.dataset.job;d.dataset.speech='form';
  const characters=sovitsStatus.characters||[];
  d.innerHTML=`<h2>多角色配音</h2><div class="field"><label for="tts-mode">配音方式</label><select id="tts-mode"><option value="single">单角色配音</option><option value="dialogue" selected>多角色台词</option></select></div><p>每段台词指定角色，复用角色自己的参考音色。起点留空时接在上一段后，保留 0.2 秒停顿；填写起点可与画面对齐。</p>
    <div class="tts-config-status"><span>已保存 ${characters.length} 个角色音色</span><button data-action="tts-config">管理角色音色</button></div>
    ${dialogueLines.map((line,i)=>`<fieldset class="tts-line"><legend>第 ${i+1} 段台词</legend><div class="field"><label for="dialogue-role-${i}">说话角色</label><select id="dialogue-role-${i}" data-dialogue-index="${i}" data-dialogue-key="characterId"><option value="">请选择角色</option>${characters.map(c=>`<option value="${esc(c.id)}" ${line.characterId===c.id?'selected':''}>${esc(c.name)} · ${c.ageGroup==='child'?'儿童':'成人'}</option>`).join('')}</select></div><div class="field"><label for="dialogue-text-${i}">台词</label><textarea id="dialogue-text-${i}" data-dialogue-index="${i}" data-dialogue-key="text" rows="2">${esc(line.text)}</textarea></div><div class="field-row"><div class="field"><label for="dialogue-start-${i}">起点（秒，可留空）</label><input id="dialogue-start-${i}" type="number" min="0" step="0.01" value="${esc(line.start)}" data-dialogue-index="${i}" data-dialogue-key="start"></div><div class="field"><label for="dialogue-duration-${i}">时长上限（秒，可留空）</label><input id="dialogue-duration-${i}" type="number" min="0.01" step="0.01" value="${esc(line.duration)}" data-dialogue-index="${i}" data-dialogue-key="duration"></div></div><button class="small" data-action="tts-line-remove" data-index="${i}" ${dialogueLines.length===1?'disabled':''}>删除本段</button></fieldset>`).join('')}
    <button class="small" data-action="tts-line-add" ${dialogueLines.length>=200?'disabled':''}>＋ 添加台词</button><p class="hint">生成完整多角色 WAV，可直接设为工程旁白。超出指定时长会报错，便于调整台词或画面。</p>${error?`<p class="danger-text" role="alert">${esc(error)}</p>`:''}<div class="dialog-actions"><button data-action="close-dialog">关闭</button><button class="primary" data-action="tts-dialogue-generate" ${characters.length&&!speechBusy?'':'disabled'}>生成多角色配音</button></div>`;
}
function selectSpeechVoice(catalog){
  const choices=catalog.voices.filter(v=>speechDraft.category!=='child'||v.ageGroup==='child');
  const voice=choices.find(v=>v.id===speechDraft.voice)??choices.find(v=>v.id===catalog.defaultVoice)??choices[0];
  speechDraft.voice=voice?.id??null;speechDraft.style=voice?.styles?.includes('chat')&&speechDraft.target==='child'?'chat':'neutral';
}
function sovitsConfigForm(error=''){
  const d=$('#export-dialog');d.dataset.speech='config';
  const selected=(sovitsStatus.characters||[]).find(c=>c.id===speechConfigId);
  const config=selected||{endpoint:sovitsStatus.endpoint,referenceAudio:null,promptText:'',ageGroup:'child'};
  const candidates=assets.filter(a=>a.type==='audio'&&a.duration>=3&&a.duration<=10&&(!a.tts||a.tts.ageGroup==='child'&&a.tts.preset==='natural'));
  d.innerHTML=`<h2>角色音色配置</h2><div class="field"><label for="tts-character-select">已有角色 / 新建</label><select id="tts-character-select"><option value="" ${!selected?'selected':''}>新建角色</option>${(sovitsStatus.characters||[]).map(c=>`<option value="${esc(c.id)}" ${c.id===speechConfigId?'selected':''}>${esc(c.name)}</option>`).join('')}</select></div><div class="field-row"><div class="field"><label for="tts-character-id">角色 ID</label><input id="tts-character-id" value="${esc(selected?.id||'')}" placeholder="例如 lele、teacher" ${selected?'readonly':''}></div><div class="field"><label for="tts-character-name">角色名称</label><input id="tts-character-name" value="${esc(selected?.name||'')}" placeholder="例如 乐乐、小伙伴、老师"></div></div><p>高 Star 开源中文配音。先启动本机 api_v2.py，再选择 3–10 秒的儿童参考录音，填写录音原文。</p>
    <div class="field"><label for="tts-sovits-endpoint">本机推理地址</label><input id="tts-sovits-endpoint" value="${esc(config.endpoint||'http://127.0.0.1:9880')}" placeholder="http://127.0.0.1:9880"></div>
    <div class="field"><label for="tts-reference-asset">参考录音（素材库）</label><select id="tts-reference-asset"><option value="">${selected?'保留该角色已配置的录音':'请选择 3–10 秒音频'}</option>${candidates.map(a=>`<option value="${a.id}">${esc(a.name)} · ${a.duration.toFixed(1)} 秒</option>`).join('')}</select></div>
    <div class="field"><label for="tts-reference-file">或导入参考音频</label><input id="tts-reference-file" type="file" accept="audio/*"><div class="hint">建议清晰、无背景音乐、单人自然说话的 3–10 秒录音。</div></div>
    <div class="field"><label for="tts-reference-text">参考录音原文</label><textarea id="tts-reference-text" rows="3" maxlength="2000" placeholder="填写录音实际说出的内容">${esc(config.promptText||'')}</textarea></div>
    <div class="field"><label for="tts-reference-age">参考声音类型（由你确认）</label><select id="tts-reference-age"><option value="child" ${config.ageGroup==='child'?'selected':''}>儿童原声</option><option value="adult" ${config.ageGroup==='adult'?'selected':''}>成人原声</option></select></div>
    <div class="hint">无需云端密钥。配置保存不会提交生成；请使用你有权使用的参考录音。推理服务须与 CutPot 共用本机文件系统。</div>${error?`<p class="danger-text" role="alert">${esc(error)}</p>`:''}
    <div class="dialog-actions"><button data-action="tts-config-back">返回</button><button class="primary" data-action="tts-config-save">保存并检查服务</button></div>`;
}
async function loadSpeechVoices(){
  const provider=speechDraft.provider;
  speechBusy=true;speechCatalog=null;speechForm();
  try{const catalog=await api(`/api/tts/voices?provider=${encodeURIComponent(provider)}`);if(speechDraft.provider!==provider)return;speechCatalog=catalog;selectSpeechVoice(catalog);speechBusy=false;if($('#export-dialog').dataset.speech==='form')speechForm();}
  catch(e){if(speechDraft.provider!==provider)return;speechBusy=false;if($('#export-dialog').dataset.speech==='form')speechForm(e.message);}
}
async function openSpeech(){
  pause();const d=$('#export-dialog');delete d.dataset.job;d.dataset.speech='loading';d.innerHTML='<h2>自动配音</h2><p>正在检查可用语音服务…</p><div class="dialog-actions"><button data-action="close-dialog">关闭</button></div>';d.showModal();
  try{
    const available=await api('/api/tts/providers');speechProviders=available.providers;
    sovitsStatus=await api('/api/tts/config');
    speechDraft.provider=speechDraft.provider??available.defaultProvider;
    const previous=await api('/api/tts/jobs');
    const active=previous.find(j=>j.status==='running')??previous.filter(j=>speechDraft.target!=='child'||j.asset?.tts?.mode==='dialogue'||j.asset?.tts?.ageGroup==='child'&&j.asset?.tts?.preset==='natural').at(-1);
    if(active){
      if(active.status==='completed'){speechResult=active;if(!asset(active.asset.id))assets.push(active.asset);renderAssets();}
      d.dataset.speech=active.id;speechJobView(active);if(active.status==='running')monitorSpeech(active.id);return;
    }
    if(!speechProviders.some(p=>p.id===speechDraft.provider&&p.available)){speechForm(speechDraft.target==='child'?'请先配置 GPT-SoVITS 和儿童参考录音，再启动本机推理服务。':'默认语音服务不可用，请明确选择其他可用服务。');return;}
    speechForm();await loadSpeechVoices();
  }catch(e){d.innerHTML=`<h2>自动配音不可用</h2><p>${esc(e.message)}</p><div class="dialog-actions"><button data-action="close-dialog">关闭</button></div>`;}
}
function speechJobView(job){
  const completed=job.status==='completed',running=job.status==='running';
  const style=job.asset?.tts?.mode==='dialogue'?`多角色 · ${job.asset.tts.lines.length} 段台词`:job.asset?.tts?.preset==='child-bright'?'童声风格 · 明亮（调音效果）':job.asset?.tts?.preset==='child-soft'?'童声风格 · 柔和（调音效果）':job.asset?.tts?.ageGroup==='child'?`儿童参考音色${job.asset.tts.style==='chat'?' · 聊天语气':''}`:'';
  $('#export-dialog').innerHTML=`<h2>${completed?'旁白已生成':running?'正在生成配音':job.status==='cancelled'?'配音已取消':'配音生成失败'}</h2><p>${esc(job.name)} · ${esc(job.provider)}${style?` · ${style}`:''}</p><div class="progress-bar"><div class="progress-fill" style="width:${job.progress}%"></div></div><div class="job-message">${esc(job.message)}</div>
    ${completed?`<audio class="speech-player" aria-label="配音试听" controls src="/api/assets/${job.asset.id}/content"></audio><p>配音 ${job.duration.toFixed(2)} 秒 · 当前成片 ${total().toFixed(2)} 秒${job.duration>total()+.05?'。配音长于成片，请先增加画面时长再设置旁白。':''}</p><a href="/api/assets/${job.asset.id}/content" download="${esc(job.asset.name)}">下载 WAV 音频 ↗</a>`:''}
    <div class="dialog-actions">${running?'<button data-action="tts-cancel">取消配音</button>':'<button data-action="tts-new">继续生成</button>'}<button data-action="close-dialog">${running?'后台运行':'关闭'}</button>${completed?`<button class="primary" data-action="tts-attach" ${total()>0&&job.duration<=total()+.05?'':'disabled'}>设为工程旁白</button>`:''}</div>`;
}
async function monitorSpeech(id){
  clearInterval(speechPoll);
  const refresh=async()=>{
    try{
      const job=await api(`/api/tts/jobs/${id}`);
      if(job.status==='completed'){
        speechResult=job;if(!asset(job.asset.id))assets.push(job.asset);renderAssets();
      }
      const d=$('#export-dialog');if(d.open&&d.dataset.speech===id)speechJobView(job);
      if(job.status!=='running'){clearInterval(speechPoll);toast(job.status==='completed'?'配音已生成并加入素材库。':job.message);}
    }catch(e){clearInterval(speechPoll);toast(`配音状态读取失败：${e.message}`);}
  };
  speechPoll=setInterval(refresh,700);await refresh();
}
async function action(name){
  try{
    if(name==='tts')await openSpeech();
    if(name==='tts-config'){speechConfigId=(sovitsStatus.characters||[])[0]?.id||'';sovitsConfigForm();}
    if(name==='tts-config-back')speechForm();
    if(name==='tts-config-save'){
      $('[data-action="tts-config-save"]').disabled=true;
      const settings={characterId:$('#tts-character-id').value.trim(),characterName:$('#tts-character-name').value.trim(),endpoint:$('#tts-sovits-endpoint').value,promptText:$('#tts-reference-text').value,ageGroup:$('#tts-reference-age').value};
      const file=$('#tts-reference-file').files[0],referenceAssetId=$('#tts-reference-asset').value;
      try{
        if(file){const a=await api(`/api/assets/upload?name=${encodeURIComponent(file.name)}`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file});if(!asset(a.id))assets.push(a);settings.referenceAssetId=a.id;}
        else if(referenceAssetId)settings.referenceAssetId=referenceAssetId;
        else settings.referenceAudio=(sovitsStatus.characters||[]).find(c=>c.id===speechConfigId)?.referenceAudio;
        sovitsStatus=await send('/api/tts/config',settings,'PUT');speechProviders=(await api('/api/tts/providers')).providers;speechDraft.provider='gpt-sovits';speechDraft.target=settings.ageGroup==='child'?'child':'general';speechDraft.category=settings.ageGroup==='child'?'child':'all';speechDraft.preset='natural';speechForm();await loadSpeechVoices();
      }catch(e){sovitsConfigForm(e.message);}
    }
    if(name==='tts-line-add'){dialogueLines.push({characterId:'',text:'',start:'',duration:''});speechForm();}
    if(name==='tts-dialogue-generate'){
      const lines=dialogueLines.map(l=>({characterId:l.characterId,text:l.text,...(l.start!==''?{start:Number(l.start)}:{}),...(l.duration!==''?{duration:Number(l.duration)}:{})}));
      speechBusy=true;speechForm();
      try{const job=await send('/api/tts',{provider:'gpt-sovits',lines,name:`${project.name}-多角色配音.wav`});$('#export-dialog').dataset.speech=job.id;speechJobView(job);monitorSpeech(job.id);}
      catch(e){speechBusy=false;speechForm(e.message);}finally{speechBusy=false;}
    }
    if(name==='tts-new'){speechResult=null;speechForm();await loadSpeechVoices();}
    if(name==='tts-use-subtitle'){speechDraft.text=current()?.subtitle||'';speechForm();}
    if(name==='tts-generate'){
      if(!speechDraft.text.trim())return toast('请先输入配音文案');
      speechBusy=true;speechForm();
      try{const job=await send('/api/tts',{...speechDraft,name:`${project.name}-旁白.wav`});$('#export-dialog').dataset.speech=job.id;speechJobView(job);monitorSpeech(job.id);}
      catch(e){speechBusy=false;speechForm(e.message);}
      finally{speechBusy=false;}
    }
    if(name==='tts-cancel'){const id=$('#export-dialog').dataset.speech;if(id&&id!=='form')await send(`/api/tts/jobs/${id}/cancel`,{});}
    if(name==='tts-attach'&&speechResult){
      if(!total()||speechResult.duration>total()+.05)return toast('配音长于成片，请先增加画面时长');
      change(()=>project.narration=speechResult.asset.id);await save();$('#export-dialog').close();toast('已设为工程旁白');
    }
    if(name==='upload')$('#files').click();
    if(name==='open-project')$('#project-file').click();
    if(name==='download-project')await saveProjectFile({flush:save,notify:toast});
    if(name==='new-project'||name==='new'){
      pause();
      await createNewProject({
        flush:async()=>{await saving.catch(()=>{});clearTimeout(saveTimer);await save();},
        notify:toast,currentName:project.name,
        onCreated:async result=>{
          clearTimeout(saveTimer);undo=[];redo=[];revision=savedRevision=0;
          project=result.project;projectServerRevision=result.projectRevision;
          if(result.assets)assets=result.assets;
          selected=null;position=0;dirty();render();
        }
      });
    }
    if(name==='split'){const c=current();if(c)change(()=>{const right=splitAt(project,c.id,position,uid());selected=right.id;});}
    if(name==='trim-in')trimToPlayhead('in');
    if(name==='trim-out')trimToPlayhead('out');
    if(name==='insert')insertionForm();
    if(name==='insert-confirm')insertVisual();
    if(name==='snap'){snapping=!snapping;render();}
    if(name==='fit'){zoom=Math.max(4,Math.min(160,($('#timeline-scroll').clientWidth-138)/Math.max(1,total())));render();}
    if(name==='shortcuts'){const d=$('#export-dialog');delete d.dataset.speech;delete d.dataset.job;d.innerHTML='<h2>时间轴快捷键</h2><dl class="shortcut-list"><dt>空格</dt><dd>播放 / 暂停</dd><dt>← / →</dt><dd>逐帧移动，Shift 移动 10 帧</dd><dt>S / ⌘ B</dt><dd>在播放头处分割选中镜头</dd><dt>I / O</dt><dd>将入点 / 出点截取到播放头</dd><dt>N</dt><dd>开启 / 关闭吸附</dd><dt>Delete</dt><dd>删除选中镜头</dd><dt>⌘ Z / ⇧ ⌘ Z</dt><dd>撤销 / 重做</dd><dt>Esc</dt><dd>取消正在进行的拖动截取</dd><dt>Alt + 拖动边缘</dt><dd>暂时关闭吸附</dd></dl><div class="dialog-actions"><button data-action="close-dialog">关闭</button></div>';d.showModal();}
    if(name==='play')play();
    if(name==='previous'||name==='next'){const i=project.clips.findIndex(c=>c.id===at(position)?.c.id);const c=project.clips[Math.max(0,Math.min(project.clips.length-1,i+(name==='next'?1:-1)))];if(c)select(c.id);}
    if(name==='captions'){captions=!captions;pause();render();}
    if(name==='nav-media'||name==='nav-audio'){filter=name==='nav-audio'?'audio':'all';pause();render();}
    if(name==='demo'){if(project.clips.length&&!confirm('载入示例会替换当前时间线。请先保存工程以便恢复。'))return;pause();await saving.catch(()=>{});clearTimeout(saveTimer);const data=await send('/api/demo',{});history();project=data.project;projectServerRevision=data.projectRevision;assets=data.assets;selected=project.clips[0].id;position=0;dirty();render();toast('已载入 60 秒静态分镜预演，尚未生成配音。');}
    if(name==='arrange'){pause();history();project=await send('/api/arrange',project);dirty();position=0;render();toast('已按分镜 / shot 编号排序，锁定位置保持不变。');}
    if(name==='undo'&&undo.length){pause();redo.push(snapshot());restore(undo.pop());dirty();render();}
    if(name==='redo'&&redo.length){pause();undo.push(snapshot());restore(redo.pop());dirty();render();}
    if(name==='remove'){const c=current();if(!c)return;if(c.locked)return toast('请先解锁镜头');change(()=>{project.clips=project.clips.filter(x=>x.id!==c.id);selected=project.clips[0]?.id;});}
    if(name==='duplicate'){const c=current();if(!c)return;if(c.locked)return toast('请先解锁镜头');change(()=>{const n=structuredClone(c);n.id=uid();c.transition=null;project.clips.splice(project.clips.indexOf(c)+1,0,n);selected=n.id;});}
    if(name==='move-left')move(-1);if(name==='move-right')move(1);
    if(name==='export')await showExport();
    if(name==='close-dialog')$('#export-dialog').close();
    if(name==='start-export'){const burnSubtitles=$('#burn-subtitles').checked;await save();const j=await send('/api/render',{...project,burnSubtitles});jobs.push(j);$('#export-dialog').dataset.job=j.id;jobView(j);monitor(j.id);}
    if(name==='jobs'){
      delete $('#export-dialog').dataset.speech;
      jobs=await api('/api/jobs');const d=$('#export-dialog');
      if(jobs.length){const j=jobs.at(-1);d.dataset.job=j.id;jobView(j);if(j.status==='running')monitor(j.id);}
      else{d.innerHTML='<h2>导出任务</h2><p>还没有导出任务。完成编排后，点击右上角“导出视频”生成成片。已完成的历史文件保存在 .cutpot/exports，任务列表仅显示本次服务会话。</p><div class="dialog-actions"><button data-action="close-dialog">关闭</button></div>';delete d.dataset.job;}d.showModal();
    }
  }catch(e){toast(e.message);}
}
document.addEventListener('click',e=>{
  if(suppressClick){suppressClick=false;return;}
  const joint=e.target.closest('[data-joint]');if(joint){select(joint.dataset.joint);$('#transition-settings')?.scrollIntoView({block:'nearest'});return;}
  const speed=e.target.closest('[data-speed]');if(speed){editClip('speed',Number(speed.dataset.speed));return;}
  const transition=e.target.closest('[data-transition]');if(transition){setTransition(transition.dataset.transition);return;}
  const removeLine=e.target.closest('[data-action="tts-line-remove"]');if(removeLine&&dialogueLines.length>1){dialogueLines.splice(Number(removeLine.dataset.index),1);speechForm();return;}
  const a=e.target.closest('[data-action]');if(a){action(a.dataset.action);return;}
  const addButton=e.target.closest('[data-add]');if(addButton){add(addButton.dataset.add);return;}
  const clip=e.target.closest('[data-clip]');if(clip){selected=clip.dataset.clip;const point=clipStart(selected)+(e.clientX-clip.getBoundingClientRect().left)/zoom;seek(point);render();return;}
  const f=e.target.closest('[data-filter]');if(f){pause();filter=f.dataset.filter;render();return;}
  const cancel=e.target.closest('[data-cancel]');if(cancel){send(`/api/jobs/${cancel.dataset.cancel}/cancel`,{}).catch(e=>toast(e.message));return;}
  if(e.target.closest('#ruler'))seek((e.clientX-$('#ruler').getBoundingClientRect().left)/zoom);
});
document.addEventListener('input',e=>{
  if(e.target.dataset.dialogueKey){dialogueLines[Number(e.target.dataset.dialogueIndex)][e.target.dataset.dialogueKey]=e.target.value;}
  if(e.target.id==='tts-text')speechDraft.text=e.target.value;
  if(e.target.id==='search'){query=e.target.value;renderAssets();}
  if(e.target.id==='zoom'){zoom=Number(e.target.value);renderTimeline();}
});
document.addEventListener('change',e=>{
  const el=e.target,c=current();
  if(el.id==='tts-mode'){speechMode=el.value;speechForm();if(speechMode==='single')loadSpeechVoices();return;}
  if(el.id==='tts-character-select'){speechConfigId=el.value;sovitsConfigForm();return;}
  if(el.dataset.dialogueKey){dialogueLines[Number(el.dataset.dialogueIndex)][el.dataset.dialogueKey]=el.value;return;}
  if(el.id==='tts-target'){speechDraft.target=el.value;speechDraft.category=el.value==='child'?'child':'all';speechDraft.preset='natural';speechDraft.style='neutral';if(el.value==='child')speechDraft.provider='gpt-sovits';loadSpeechVoices();return;}
  if(el.id==='tts-provider'){speechDraft.provider=el.value;loadSpeechVoices();return;}
  if(el.id==='tts-preset'){speechDraft.preset=el.value;return;}
  if(el.id==='tts-category'){speechDraft.category=el.value;const voices=(speechCatalog?.voices||[]).filter(v=>el.value!=='child'||v.ageGroup==='child');if(!voices.some(v=>v.id===speechDraft.voice))speechDraft.voice=voices[0]?.id??null;speechForm();return;}
  if(el.id==='tts-voice'){speechDraft.voice=el.value;const v=speechCatalog?.voices.find(v=>v.id===el.value);speechDraft.style=v?.styles?.includes('chat')&&speechDraft.target==='child'?'chat':'neutral';speechForm();return;}
  if(el.id==='tts-style'){speechDraft.style=el.value;return;}
  if(el.id==='tts-speed'){speechDraft.speed=Number(el.value);return;}
  if(el.id==='project-name'){history();project.name=el.value||'未命名项目';dirty();return;}
  if(el.dataset.field&&c){
    const key=el.dataset.field;
    if(key==='transitionDuration'){setTransition(c.transition?.type,Number(el.value));return;}
    editClip(key,el.type==='checkbox'?el.checked:['duration','sourceIn','sourceOut','speed'].includes(key)?Number(el.value):el.value);
  }
  if(el.dataset.audio)change(()=>project[el.dataset.audio]=el.value||null);
  if(el.id==='music-volume')change(()=>project.musicVolume=Number(el.value));
  if(el.id==='resolution')change(()=>{[project.width,project.height]=el.value.split(',').map(Number);});
  if(el.id==='fps')change(()=>{project.fps=Number(el.value);project.clips.forEach(c=>{c.duration=Math.max(1,Math.floor(c.duration*project.fps+1e-7))/project.fps;});});
});
$('#files').addEventListener('change',e=>upload([...e.target.files]));
$('#project-file').addEventListener('change',async e=>{try{await importProjectFile(e.target.files[0],{
  revisions:async()=>{pause();await save();const file=await api('/api/project-file');return {editorRevision:projectServerRevision,creationRevision:file.creationRevision};},
  onImported:async result=>{clearTimeout(saveTimer);project=result.project;projectServerRevision=result.projectRevision;undo=[];redo=[];revision=savedRevision=0;position=0;selected=project.clips[0]?.id;render();toast('工程已导入，分镜、视频版本与时间轴已恢复');}
});}catch(error){toast(error.message);}finally{e.target.value='';}});
function bindDrop(){const zone=$('#drop-zone');zone.addEventListener('dragover',e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();zone.classList.add('drop-active');}});zone.addEventListener('dragleave',()=>zone.classList.remove('drop-active'));zone.addEventListener('drop',e=>{e.preventDefault();zone.classList.remove('drop-active');if(e.dataTransfer.files.length)upload([...e.dataTransfer.files]);});}
let dragged=null;
document.addEventListener('dragstart',e=>{const c=e.target.closest('[data-clip]');if(c&&!dragEdit&&!project.clips.find(x=>x.id===c.dataset.clip)?.locked){dragged=c.dataset.clip;e.dataTransfer.setData('text/plain',dragged);}});
document.addEventListener('dragover',e=>{if(dragged&&e.target.closest('[data-clip]'))e.preventDefault();});
document.addEventListener('drop',e=>{const target=e.target.closest('[data-clip]');if(!dragged||!target)return;e.preventDefault();const from=project.clips.findIndex(c=>c.id===dragged),to=project.clips.findIndex(c=>c.id===target.dataset.clip);dragged=null;if(from===to||from<0||to<0)return;if(project.clips.slice(Math.min(from,to),Math.max(from,to)+1).some(c=>c.locked))return toast('不能跨越锁定镜头');change(()=>{const [c]=project.clips.splice(from,1);project.clips.splice(to,0,c);selected=c.id;position=clipStart(c.id);});});
document.addEventListener('dragend',()=>dragged=null);
document.addEventListener('pointerdown',e=>{
  const handle=e.target.closest('[data-trim]'),scrub=e.target.closest('#ruler,#playhead');
  if(e.button!==0||(!handle&&!scrub))return;
  pause();e.preventDefault();
  const scroll=$('#timeline-scroll');
  if(handle){
    const id=handle.closest('[data-clip]').dataset.clip;selected=id;
    dragEdit={kind:'trim',id,edge:handle.dataset.trim,x:e.clientX,scroll:scroll.scrollLeft,before:structuredClone(project),position};
    clearTimeout(saveTimer);renderInspector();
  }else{dragEdit={kind:'scrub'};seek((e.clientX-$('#ruler').getBoundingClientRect().left)/zoom);}
  $('#app').setPointerCapture(e.pointerId);
});
document.addEventListener('pointermove',e=>{
  if(!dragEdit)return;
  if(dragEdit.kind==='scrub'){seek((e.clientX-$('#ruler').getBoundingClientRect().left)/zoom);return;}
  const scroll=$('#timeline-scroll'),bounds=scroll.getBoundingClientRect();
  if(e.clientX>bounds.right-32)scroll.scrollLeft+=12;else if(e.clientX<bounds.left+122)scroll.scrollLeft-=12;
  project=structuredClone(dragEdit.before);
  const item=timeline(project).find(i=>i.clip.id===dragEdit.id);
  let delta=(e.clientX-dragEdit.x+scroll.scrollLeft-dragEdit.scroll)/zoom;
  if(snapping&&!e.altKey){
    const edge=dragEdit.edge==='in'?item.start:item.end, target=edge+delta;
    const points=[dragEdit.position,...timeline(project).filter(i=>i.clip.id!==dragEdit.id).flatMap(i=>[i.start,i.end])];
    const near=points.sort((a,b)=>Math.abs(a-target)-Math.abs(b-target))[0];
    if(Math.abs(near-target)*zoom<8)delta=near-edge;
  }
  const c=trimEdge(project,dragEdit.id,dragEdit.edge,delta,asset(item.clip.assetId));
  const adjusted=timeline(project).find(i=>i.clip.id===c.id);
  position=Math.max(adjusted.start,Math.min(total(),dragEdit.edge==='in'?adjusted.start:adjusted.end-1/project.fps));
  renderTimeline();renderInspector();updatePreview();updateTransport();
  $('#edit-feedback').textContent=`${dragEdit.edge==='in'?'入点':'出点'} ${Number((dragEdit.edge==='in'?c.sourceIn:sourceOut(c)).toFixed(3))}s · 片段 ${c.duration.toFixed(2)}s · 松开完成，Esc 取消`;
});
function finishDrag(cancel=false){
  if(!dragEdit)return;
  if(dragEdit.kind==='trim'){
    if(cancel){project=dragEdit.before;position=dragEdit.position;}
    else if(JSON.stringify(project)!==JSON.stringify(dragEdit.before)){undo.push({project:dragEdit.before,selected:dragEdit.id,position:dragEdit.position});if(undo.length>50)undo.shift();redo=[];dirty();}
    else if(revision!==savedRevision)dirty();
  }
  dragEdit=null;suppressClick=true;setTimeout(()=>suppressClick=false,0);render();
}
document.addEventListener('pointerup',()=>finishDrag());
document.addEventListener('pointercancel',()=>finishDrag(true));
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&dragEdit){e.preventDefault();finishDrag(true);return;}
  if(e.target.matches('input,textarea,select')||e.target.isContentEditable||$('#export-dialog').open)return;
  const key=e.key.toLowerCase(),command=e.metaKey||e.ctrlKey;
  if(e.code==='Space'){e.preventDefault();play();return;}
  if(command&&key==='z'){e.preventDefault();action(e.shiftKey?'redo':'undo');return;}
  if(command&&key==='y'){e.preventDefault();action('redo');return;}
  if((command&&key==='b')||!command&&!e.altKey&&key==='s'){e.preventDefault();action('split');return;}
  if(key==='arrowleft'||key==='arrowright'){e.preventDefault();seek(position+(key==='arrowleft'?-1:1)*(e.shiftKey?10:1)/project.fps);return;}
  if(!command&&!e.altKey&&['i','o','n','delete','backspace','?'].includes(key)){e.preventDefault();action({i:'trim-in',o:'trim-out',n:'snap',delete:'remove',backspace:'remove','?':'shortcuts'}[key]);return;}
  if(e.key==='Enter'&&e.target.dataset.clip)select(e.target.dataset.clip);
});
window.addEventListener('beforeunload',e=>{if(revision!==savedRevision){e.preventDefault();e.returnValue='';}});
try{const data=await api('/api/state');project=data.project;projectServerRevision=data.projectRevision;assets=data.assets;jobs=data.jobs;engine=data.engine;selected=project.clips[0]?.id;render();const active=jobs.find(j=>j.status==='running');if(active)monitor(active.id);}catch(e){$('#app').innerHTML=`<div class="error-panel">工作台加载失败：${esc(e.message)}<br>请确认本地服务已启动，然后刷新页面。</div>`;}
