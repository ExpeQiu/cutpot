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
let project, assets=[], jobs=[], engine=false, selected=null, filter='all', query='', position=0, playing=false, captions=true, zoom=24;
let undo=[],redo=[],saveTimer,saving=Promise.resolve(),revision=0,savedRevision=0,uploading=false,clockStart=0,startPosition=0,raf,poll;
let speechConfigId='reference',dialogueLines=[{characterId:'',text:'',start:'',duration:''}],speechMode='single';
let speechDraft={text:'',provider:'gpt-sovits',voice:null,speed:.95,preset:'natural',category:'child',target:'child',style:'neutral'},speechProviders=[],speechCatalog=null,speechResult=null,speechPoll,speechBusy=false,sovitsStatus={configured:false,endpoint:'http://127.0.0.1:9880',referenceAudio:null,promptText:'',ageGroup:'child'};
const asset = id=>assets.find(a=>a.id===id);
const total = ()=>project.clips.reduce((s,c)=>s+Math.round(c.duration*project.fps),0)/project.fps;
const current = ()=>project.clips.find(c=>c.id===selected);
const time = seconds=>{const n=Math.floor(Math.max(0,seconds));return `${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`;};
const precise = seconds=>`${time(seconds)}:${String(Math.floor((Math.max(0,seconds)%1)*project.fps+0.00001)).padStart(2,'0')}`;
async function api(url,options={}) {
  const res=await fetch(url,options);const data=await res.json();if(!res.ok)throw new Error(data.error||'请求失败');return data;
}
const send = (url,data,method='POST')=>api(url,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
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
function history(){undo.push(structuredClone(project));if(undo.length>50)undo.shift();redo=[];}
function change(fn){pause();history();fn();position=Math.min(position,total());dirty();render();}
function clipStart(id){let t=0;for(const c of project.clips){if(c.id===id)return t;t+=c.duration;}return 0;}
function select(id){pause();selected=id;position=clipStart(id);renderInspector();renderTimeline();updatePreview(true);updateTransport();}

function render(){
  $('#app').innerHTML=`<main class="shell">
    <header class="top"><div class="brand"><span class="brand-mark">c</span>CutPot</div><div class="divider"></div>
      <input class="project-name" id="project-name" aria-label="项目名称" value="${esc(project.name)}"><span class="save-state" id="save-state">${revision===savedRevision?'已保存到本机':'等待保存'}</span>
      <div class="spacer"></div><span class="local-badge">本地工作台 · ${engine?'渲染引擎就绪':'未检测到 FFmpeg'}</span>
      <button class="ghost small" data-action="open-project">打开工程</button><button class="ghost small" data-action="download-project">保存工程</button>
      <button class="primary" data-action="export">导出视频 ↗</button></header>
    <nav class="rail" aria-label="工作区"><button class="nav-item ${filter!=='audio'?'active':''}" data-action="nav-media">${icon('media')}素材</button><button class="nav-item ${filter==='audio'?'active':''}" data-action="nav-audio">${icon('audio')}声音</button><button class="nav-item" data-action="tts">${icon('audio')}自动配音</button><button class="nav-item" data-action="jobs">${icon('export')}导出</button><div class="rail-bottom">v0.8</div></nav>
    <aside class="library" id="drop-zone"><div class="panel-head"><h2>素材库 <span class="count">${assets.length}</span></h2><button class="ghost small" data-action="upload">＋ 导入</button></div>
      <div class="library-tools"><input id="search" placeholder="搜索素材名称…" aria-label="搜索素材" value="${esc(query)}"><div class="library-tabs">${[['all','全部'],['video','视频'],['image','图片'],['audio','音频']].map(([id,name])=>`<button class="filter ${filter===id?'active':''}" data-filter="${id}">${name}</button>`).join('')}</div></div>
      <div class="asset-list" id="asset-list"></div><div class="library-foot"><button class="small ghost" data-action="demo">载入乐乐示例</button><button class="small ghost" data-action="new">新建工程</button></div></aside>
    <section class="preview-panel"><div class="preview-head"><span>成片预览 <span id="preview-shot" class="muted"></span></span><span class="tag">${project.width} × ${project.height} · ${project.fps} FPS</span></div><div class="stage-wrap"><div class="stage" id="stage"></div></div>
      <div class="preview-transport"><div class="time-display" id="time-display"></div><div class="play-controls"><button data-action="previous" aria-label="上一个镜头">‹</button><button class="play" data-action="play" id="play" aria-label="播放或暂停">▶</button><button data-action="next" aria-label="下一个镜头">›</button></div><button class="ghost small caption-toggle" data-action="captions">字幕预览 ${captions?'开':'关'}</button></div>
      <audio id="voice-audio" preload="metadata"></audio><audio id="music-audio" preload="metadata" loop></audio></section>
    <aside class="inspector"><div class="panel-head"><h2>镜头设置</h2><small>INSPECTOR</small></div><div id="inspector-body" class="inspector-body"></div></aside>
    <section class="timeline"><div class="timeline-toolbar"><h2>分镜时间线</h2><button class="ghost small" data-action="undo" ${undo.length?'':'disabled'}>↶</button><button class="ghost small" data-action="redo" ${redo.length?'':'disabled'}>↷</button><span class="divider"></span><button class="small" data-action="arrange">按分镜编号编排</button><button class="ghost small" data-action="duplicate">复制</button><button class="ghost small" data-action="remove">删除</button><div class="spacer"></div><span class="duration">${project.clips.length} 个镜头 · ${time(total())}</span><label style="margin:0;width:90px"><input type="range" min="8" max="70" value="${zoom}" id="zoom" aria-label="时间线缩放"></label></div><div class="timeline-scroll" id="timeline-scroll"></div>
      <footer class="status-bar"><span>硬切拼接</span><span>·</span><span>支持画面字幕 / SRT</span><div class="spacer"></div><span>空格 播放 / 暂停</span><span>·</span><span>⌘ Z 撤销</span></footer></section></main>`;
  renderAssets();renderInspector();renderTimeline();updatePreview(true);updateTransport();setupAudio();bindDrop();
}
function renderAssets(){
  const count=$('.library .count');if(count)count.textContent=assets.length;
  const list=assets.filter(a=>(filter==='all'||a.type===filter)&&a.name.toLowerCase().includes(query.toLowerCase()));
  $('#asset-list').innerHTML=list.length?list.map(a=>`<div class="asset">${a.thumbnail?`<img class="asset-thumb" src="${a.thumbnail}" alt="">`:'<div class="asset-thumb audio-thumb">♫</div>'}<div class="asset-info"><div class="asset-name" title="${esc(a.name)}">${esc(a.name)}</div><small>${a.type==='image'?`${a.width} × ${a.height}`:`${time(a.duration)} · ${a.type==='audio'?'音频':`${a.width} × ${a.height}`}`}</small></div><button class="asset-add" data-add="${a.id}" aria-label="添加 ${esc(a.name)}">＋</button></div>`).join(''):`<div class="empty-library">${assets.length?'没有符合条件的素材。':'将 AI 视频、图片或声音拖入这里。<br>支持批量导入，单文件最多 1 GB。<br><br>也可载入现有乐乐分镜，立即体验 60 秒组片。'}</div>`;
}
function renderInspector(){
  const c=current(), a=c?asset(c.assetId):null;
  $('#inspector-body').innerHTML=`${c?`<div class="clip-number">SHOT ${String(project.clips.indexOf(c)+1).padStart(2,'0')}</div><div class="field"><label for="clip-title">镜头名称</label><input id="clip-title" data-field="title" value="${esc(c.title)}"></div>
    <div class="field"><label for="clip-asset">关联素材 / 替换版本</label><select id="clip-asset" data-field="assetId">${assets.filter(x=>x.type!=='audio').map(x=>`<option value="${x.id}" ${x.id===a.id?'selected':''}>${esc(x.name)}</option>`).join('')}</select><div class="hint">替换时保持镜头时长、字幕与位置。</div></div>
    <div class="field-row"><div class="field"><label>时长（秒）</label><input type="number" min="${1/project.fps}" step="${1/project.fps}" data-field="duration" value="${c.duration}"></div><div class="field"><label>素材入点（秒）</label><input type="number" min="0" step="${1/project.fps}" data-field="sourceIn" value="${c.sourceIn}" ${a.type==='image'?'disabled':''}></div></div>
    <div class="hint">${a.type==='video'?`源视频 ${a.duration.toFixed(2)} 秒；不会自动延长或重复。`:'静态图片按镜头时长保持画面。'}</div>
    <label class="switch-row"><input type="checkbox" data-field="muted" ${c.muted?'checked':''} ${a.hasAudio?'':'disabled'}> 静音素材原声</label><label class="switch-row"><input type="checkbox" data-field="locked" ${c.locked?'checked':''}> 锁定镜头（编排与编辑时保留）</label>
    <div class="field"><label>镜头字幕</label><textarea rows="3" data-field="subtitle" ${c.locked?'disabled':''}>${esc(c.subtitle)}</textarea><div class="hint">按本镜头区间显示；导出时可将字幕烧录至视频画面。</div></div><div class="field-row"><button class="small" data-action="move-left">← 前移</button><button class="small" data-action="move-right">后移 →</button></div>`:'<div class="empty-inspector">选中时间线中的镜头，调整素材、时长与字幕。</div>'}
    <div class="section-label">项目输出</div><div class="field-row"><div class="field"><label>画幅 / 分辨率</label><select id="resolution">${[[1920,1080,'1080p 横屏'],[1280,720,'720p 横屏'],[1080,1920,'1080p 竖屏']].map(([w,h,n])=>`<option value="${w},${h}" ${project.width===w&&project.height===h?'selected':''}>${n}</option>`).join('')}</select></div><div class="field"><label>帧率</label><select id="fps">${[24,25,30].map(v=>`<option ${project.fps===v?'selected':''}>${v}</option>`).join('')}</select></div></div>
    <div class="section-label">声音轨道</div>${['narration','music'].map(key=>`<div class="field"><label>${key==='narration'?'旁白（从成片开头播放）':'背景音乐（循环至结尾）'}</label><select data-audio="${key}"><option value="">不使用</option>${assets.filter(x=>x.type==='audio').map(x=>`<option value="${x.id}" ${project[key]===x.id?'selected':''}>${esc(x.name)}</option>`).join('')}</select></div>`).join('')}
    <div class="field"><label>音乐音量 ${Math.round(project.musicVolume*100)}%</label><input type="range" min="0" max="1" step="0.01" value="${project.musicVolume}" id="music-volume"><div class="hint">首版使用固定音量混音，导出含结尾淡出。</div></div>`;
  if(c?.locked)$('#inspector-body').querySelectorAll('[data-field]:not([data-field="locked"])').forEach(el=>el.disabled=true);
}
function renderTimeline(){
  const width=Math.max(total()*zoom,600),step=zoom<16?10:5;
  let ticks='';for(let s=0;s<=total();s+=step)ticks+=`<span class="tick" style="left:${s*zoom}px">${time(s)}</span>`;
  $('#timeline-scroll').innerHTML=`<div style="position:relative;min-width:${width+110}px"><div class="ruler" id="ruler" style="width:${width}px">${ticks}</div><div class="track-row"><div class="track-label">V1 · 主画面</div><div class="clip-track">${project.clips.map(c=>`<div role="button" tabindex="0" aria-label="${esc(c.title)}" class="timeline-clip ${c.id===selected?'selected':''}" data-clip="${c.id}" draggable="${!c.locked}" style="width:${c.duration*zoom}px">${asset(c.assetId)?.thumbnail?`<img src="${asset(c.assetId).thumbnail}" alt="">`:''}<span class="clip-title">${esc(c.title)}</span>${c.locked?'<span class="lock-indicator">锁定</span>':''}</div>`).join('')}</div></div>${['narration','music'].map((key,i)=>`<div class="track-row"><div class="track-label">A${i+1} · ${i?'背景音乐':'旁白'}</div>${project[key]?`<div class="audio-track ${i?'music':''}" style="width:${Math.min(total(),i?total():asset(project[key]).duration)*zoom}px">♫ ${esc(asset(project[key]).name)}</div>`:'<div class="track-placeholder">在右侧声音轨道中选择音频素材</div>'}</div>`).join('')}<div class="playhead" id="playhead" style="left:${90+position*zoom}px"></div></div>`;
}
let previewAsset=null, previewClip=null;
function at(t){let start=0;for(const c of project.clips){if(t<start+c.duration-0.00001||c===project.clips.at(-1))return {c,start};start+=c.duration;}return null;}
function updatePreview(force=false){
  const item=at(position),stage=$('#stage');if(!stage)return;
  if(!item){stage.innerHTML=`<div class="stage-empty">${icon('film')}<strong>让零散镜头，成为完整故事</strong><p>导入 AI 生成的视频，按分镜编排。<br>从一次简单的初剪开始。</p><button class="primary" data-action="upload">＋ 导入素材</button> <button class="ghost" data-action="demo">体验乐乐示例 →</button></div>`;previewAsset=null;previewClip=null;return;}
  const {c,start}=item,a=asset(c.assetId);const offset=c.sourceIn+position-start;
  stage.style.aspectRatio=`${project.width}/${project.height}`;
  if(force||previewAsset!==a.id||previewClip!==c.id){
    stage.innerHTML=`${a.type==='image'?`<img src="/api/assets/${a.id}/content" alt="${esc(c.title)}">`:`<video id="preview-video" src="/api/assets/${a.id}/content" playsinline preload="auto"></video>`}<div class="caption" id="caption"></div>`;
    previewAsset=a.id;previewClip=c.id;
    const video=$('#preview-video');if(video){video.muted=c.muted;video.addEventListener('loadedmetadata',()=>{video.currentTime=Math.min(offset,Math.max(0,video.duration-.02));if(playing)video.play().catch(()=>{});},{once:true});video.addEventListener('error',()=>{if(playing)pause();toast('此视频格式无法在浏览器预览；可转为 MP4 后导入。');},{once:true});}
  }
  const video=$('#preview-video');if(video?.readyState>=1&&(force||Math.abs(video.currentTime-offset)>.22))video.currentTime=offset;
  $('#caption').textContent=captions?c.subtitle:'';
  $('#preview-shot').textContent=` / ${String(project.clips.indexOf(c)+1).padStart(2,'0')} · ${c.title}`;
}
function setupAudio(){for(const [key,id] of [['narration','voice-audio'],['music','music-audio']]){const el=$(`#${id}`);if(project[key]){el.src=`/api/assets/${project[key]}/content`;el.volume=key==='music'?project.musicVolume:1;}}}
function syncAudio(){for(const [key,id] of [['narration','voice-audio'],['music','music-audio']]){const el=$(`#${id}`);if(!project[key]||!el||!Number.isFinite(el.duration))continue;const t=key==='music'?position%el.duration:Math.min(position,el.duration);if(Math.abs(el.currentTime-t)>.25)el.currentTime=t;if(playing&&t<el.duration)el.play().catch(()=>{});}}
function updateTransport(){if(!$('#time-display'))return;$('#time-display').innerHTML=`${precise(position)} <span>/ ${precise(total())}</span>`;if($('#playhead'))$('#playhead').style.left=`${90+position*zoom}px`;$('#play').textContent=playing?'Ⅱ':'▶';}
function pause(){playing=false;cancelAnimationFrame(raf);$('#preview-video')?.pause();$('#voice-audio')?.pause();$('#music-audio')?.pause();updateTransport();}
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
async function showExport(){pause();const d=$('#export-dialog');delete d.dataset.speech;delete d.dataset.job;d.innerHTML=`<h2>导出完整视频</h2><p>画面按时间线硬切拼接，音频统一混音。可将镜头字幕直接显示在视频画面中，同时保留独立 SRT。</p><label class="field"><span><input id="burn-subtitles" type="checkbox" checked> 将字幕显示在视频画面中（烧录字幕）</span><span class="hint">底部居中、白字黑边；字幕按镜头区间显示。</span></label><div class="export-options"><div>H.264 / MP4<small>${project.width} × ${project.height} · ${project.fps} fps</small></div><div>${time(total())}<small>${project.clips.length} 个镜头 · AAC 音频</small></div></div><p>只在本机处理。导出结果保存在项目目录的 .cutpot/exports 中。</p><div class="dialog-actions"><button data-action="close-dialog">取消</button><button class="primary" data-action="start-export" ${!engine||!project.clips.length?'disabled':''}>开始导出 ↗</button></div>`;d.showModal();}
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
    if(name==='download-project'){await save();download(`${project.name}.cutpot.json`,project);}
    if(name==='play')play();
    if(name==='previous'||name==='next'){const i=project.clips.findIndex(c=>c.id===at(position)?.c.id);const c=project.clips[Math.max(0,Math.min(project.clips.length-1,i+(name==='next'?1:-1)))];if(c)select(c.id);}
    if(name==='captions'){captions=!captions;pause();render();}
    if(name==='nav-media'||name==='nav-audio'){filter=name==='nav-audio'?'audio':'all';pause();render();}
    if(name==='demo'){if(project.clips.length&&!confirm('载入示例会替换当前时间线。请先保存工程以便恢复。'))return;pause();await saving.catch(()=>{});clearTimeout(saveTimer);const data=await send('/api/demo',{});history();project=data.project;assets=data.assets;selected=project.clips[0].id;position=0;dirty();render();toast('已载入 60 秒静态分镜预演，尚未生成配音。');}
    if(name==='new'){if(project.clips.length&&!confirm('新建空工程？素材库会保留，当前时间线可通过撤销恢复。'))return;change(()=>{project={version:1,id:uid(),name:'未命名项目',fps:25,width:1920,height:1080,clips:[],narration:null,music:null,musicVolume:.12};selected=null;position=0;});}
    if(name==='arrange'){pause();history();project=await send('/api/arrange',project);dirty();position=0;render();toast('已按分镜 / shot 编号排序，锁定位置保持不变。');}
    if(name==='undo'&&undo.length){pause();redo.push(structuredClone(project));project=undo.pop();selected=project.clips.find(c=>c.id===selected)?.id||project.clips[0]?.id;position=0;dirty();render();}
    if(name==='redo'&&redo.length){pause();undo.push(structuredClone(project));project=redo.pop();selected=project.clips[0]?.id;position=0;dirty();render();}
    if(name==='remove'){const c=current();if(!c)return;if(c.locked)return toast('请先解锁镜头');change(()=>{project.clips=project.clips.filter(x=>x.id!==c.id);selected=project.clips[0]?.id;});}
    if(name==='duplicate'){const c=current();if(!c)return;if(c.locked)return toast('请先解锁镜头');change(()=>{const n={...c,id:uid()};project.clips.splice(project.clips.indexOf(c)+1,0,n);selected=n.id;});}
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
  const removeLine=e.target.closest('[data-action="tts-line-remove"]');if(removeLine&&dialogueLines.length>1){dialogueLines.splice(Number(removeLine.dataset.index),1);speechForm();return;}
  const a=e.target.closest('[data-action]');if(a){action(a.dataset.action);return;}
  const addButton=e.target.closest('[data-add]');if(addButton){add(addButton.dataset.add);return;}
  const clip=e.target.closest('[data-clip]');if(clip){select(clip.dataset.clip);return;}
  const f=e.target.closest('[data-filter]');if(f){pause();filter=f.dataset.filter;render();return;}
  const cancel=e.target.closest('[data-cancel]');if(cancel){send(`/api/jobs/${cancel.dataset.cancel}/cancel`,{}).catch(e=>toast(e.message));return;}
  if(e.target.closest('#ruler')){pause();position=Math.max(0,Math.min(total(),(e.clientX-$('#ruler').getBoundingClientRect().left)/zoom));selected=at(position)?.c.id;renderInspector();updatePreview(true);updateTransport();}
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
    const key=el.dataset.field;if(c.locked&&key!=='locked')return;
    let value=el.type==='checkbox'?el.checked:['duration','sourceIn'].includes(key)?Number(el.value):el.value;
    if(key==='duration')value=Math.round(value*project.fps)/project.fps;
    const candidate={...c,[key]:value};if(key==='assetId')candidate.sourceIn=0;
    const a=asset(candidate.assetId);
    if(!Number.isFinite(candidate.duration)||candidate.duration<1/project.fps||candidate.duration>3600||!Number.isFinite(candidate.sourceIn)||candidate.sourceIn<0||a.type==='video'&&candidate.sourceIn+candidate.duration>a.duration+.025){toast('时长或入点无效，不能超出源视频的可用范围。');renderInspector();return;}
    change(()=>Object.assign(c,candidate));
  }
  if(el.dataset.audio)change(()=>project[el.dataset.audio]=el.value||null);
  if(el.id==='music-volume')change(()=>project.musicVolume=Number(el.value));
  if(el.id==='resolution')change(()=>{[project.width,project.height]=el.value.split(',').map(Number);});
  if(el.id==='fps')change(()=>{project.fps=Number(el.value);project.clips.forEach(c=>c.duration=Math.round(c.duration*project.fps)/project.fps);});
});
$('#files').addEventListener('change',e=>upload([...e.target.files]));
$('#project-file').addEventListener('change',async e=>{try{const file=e.target.files[0];if(!file)return;const data=JSON.parse(await file.text());if(!confirm('打开工程会替换当前时间线，素材需要仍存在于本机素材库。'))return;pause();clearTimeout(saveTimer);await saving.catch(()=>{});const validated=await send('/api/project',data,'PUT');history();project=validated;position=0;selected=project.clips[0]?.id;dirty();render();toast('工程已打开');}catch(e){toast(`打开失败：${e.message}`);}finally{e.target.value='';}});
function bindDrop(){const zone=$('#drop-zone');zone.addEventListener('dragover',e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();zone.classList.add('drop-active');}});zone.addEventListener('dragleave',()=>zone.classList.remove('drop-active'));zone.addEventListener('drop',e=>{e.preventDefault();zone.classList.remove('drop-active');if(e.dataTransfer.files.length)upload([...e.dataTransfer.files]);});}
let dragged=null;
document.addEventListener('dragstart',e=>{const c=e.target.closest('[data-clip]');if(c){dragged=c.dataset.clip;e.dataTransfer.setData('text/plain',dragged);}});
document.addEventListener('dragover',e=>{if(dragged&&e.target.closest('[data-clip]'))e.preventDefault();});
document.addEventListener('drop',e=>{const target=e.target.closest('[data-clip]');if(!dragged||!target)return;e.preventDefault();const from=project.clips.findIndex(c=>c.id===dragged),to=project.clips.findIndex(c=>c.id===target.dataset.clip);dragged=null;if(from===to||from<0||to<0)return;if(project.clips.slice(Math.min(from,to),Math.max(from,to)+1).some(c=>c.locked))return toast('不能跨越锁定镜头');change(()=>{const [c]=project.clips.splice(from,1);project.clips.splice(to,0,c);selected=c.id;position=clipStart(c.id);});});
document.addEventListener('dragend',()=>dragged=null);
document.addEventListener('keydown',e=>{if(e.target.matches('input,textarea,select')||$('#export-dialog').open)return;if(e.code==='Space'){e.preventDefault();play();}if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='z'){e.preventDefault();action(e.shiftKey?'redo':'undo');}if(e.key==='Enter'&&e.target.dataset.clip)select(e.target.dataset.clip);});
window.addEventListener('beforeunload',e=>{if(revision!==savedRevision){e.preventDefault();e.returnValue='';}});
try{const data=await api('/api/state');project=data.project;assets=data.assets;jobs=data.jobs;engine=data.engine;selected=project.clips[0]?.id;render();const active=jobs.find(j=>j.status==='running');if(active)monitor(active.id);}catch(e){$('#app').innerHTML=`<div class="error-panel">工作台加载失败：${esc(e.message)}<br>请确认本地服务已启动，然后刷新页面。</div>`;}
