async function request(url,options){
  const response=await fetch(url,options),data=await response.json();
  if(!response.ok)throw new Error(data.error||'工程操作失败');
  return data;
}

function safeName(name){
  return String(name||'未命名项目').replace(/[\\/:*?"<>|]+/g,'_').replace(/\s+/g,' ').trim().slice(0,80)||'未命名项目';
}

function isZipProject(file){
  const name=String(file?.name||'').toLowerCase();
  return name.endsWith('.cutpot.zip')||name.endsWith('.zip')||file?.type==='application/zip'||file?.type==='application/x-zip-compressed';
}

async function downloadBlob(response,fallbackName){
  if(!response.ok){
    let message='工程包下载失败';
    try{message=(await response.json()).error||message;}catch{}
    if(response.status===404||/接口不存在/.test(message))message='保存工程接口不可用，请先停止并重新启动 CutPot 服务';
    throw new Error(message);
  }
  const blob=await response.blob();
  const header=response.headers.get('Content-Disposition')||'';
  const utf= /filename\*=UTF-8''([^;]+)/i.exec(header);
  const plain=/filename="?([^";]+)"?/i.exec(header);
  const fileName=utf?decodeURIComponent(utf[1]):plain?plain[1]:fallbackName;
  const url=URL.createObjectURL(blob);
  const link=document.createElement('a');link.href=url;link.download=fileName;link.click();
  setTimeout(()=>URL.revokeObjectURL(url),2000);
  return {fileName,bytes:blob.size};
}

export async function createNewProject({flush,notify,onCreated,currentName=''}){
  let dialog=document.querySelector('#project-new-dialog');
  if(!dialog){dialog=document.createElement('dialog');dialog.id='project-new-dialog';document.body.append(dialog);}
  dialog.innerHTML=`<h2>新增项目</h2><p>请选择本机项目文件夹。之后分镜、视频、素材、生成记录与导出都会保存在该目录下的 <code>.cutpot</code> 中。请先保存当前工程以便恢复。</p><form id="project-new-form"><label for="project-new-name">项目名称</label><input id="project-new-name" name="name" maxlength="120" required value=""><label for="project-new-dir">项目文件夹</label><div class="project-dir-row"><input id="project-new-dir" name="projectDir" required readonly placeholder="尚未选择"><button type="button" data-pick-folder>选择文件夹</button></div><p class="hint">创作记录不会再写入旧项目目录；可随时用「保存工程」打出可迁移压缩包。</p><div class="project-import-actions"><button type="button" data-new-cancel>取消</button><button type="submit" class="primary">新建并打开</button></div><p class="project-import-error" role="alert" hidden></p></form>`;
  const input=dialog.querySelector('#project-new-name');
  const dirInput=dialog.querySelector('#project-new-dir');
  input.value='';
  input.placeholder=currentName?`例如：${currentName}`:'未命名项目';
  dirInput.value='';
  dialog.querySelector('[data-new-cancel]').onclick=()=>dialog.close();
  dialog.querySelector('[data-pick-folder]').onclick=async()=>{
    const error=dialog.querySelector('.project-import-error');
    const button=dialog.querySelector('[data-pick-folder]');
    error.hidden=true;button.disabled=true;button.textContent='选择中…';
    try{
      const result=await request('/api/project/pick-folder',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
      dirInput.value=result.projectDir;
      if(!input.value.trim())input.value=result.projectDir.split(/[/\\]/).filter(Boolean).at(-1)||'';
    }catch(err){error.textContent=err.message;error.hidden=false;}
    finally{button.disabled=false;button.textContent='选择文件夹';}
  };
  const form=dialog.querySelector('#project-new-form');
  form.onsubmit=async e=>{
    e.preventDefault();
    const error=dialog.querySelector('.project-import-error');
    const button=form.querySelector('button.primary');
    error.hidden=true;button.disabled=true;button.textContent='创建中…';
    try{
      if(!dirInput.value.trim())throw new Error('请先选择项目文件夹');
      if(flush)await flush();
      const name=input.value.trim()||'未命名项目';
      console.info('[project-new] client start',{name,projectDir:dirInput.value});
      const result=await request('/api/project/new',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,projectDir:dirInput.value})});
      dialog.close();
      await onCreated(result);
      notify?.(`已新建项目：${result.project.name} → ${result.projectDir}`);
    }catch(err){error.textContent=err.message;error.hidden=false;}
    finally{button.disabled=false;button.textContent='新建并打开';}
  };
  dialog.showModal();
  input.focus();
}

export async function saveProjectFile({flush,notify}){
  const buttons=[...document.querySelectorAll('[data-action="download-project"]')];
  buttons.forEach(b=>{b.disabled=true;b.setAttribute('aria-busy','true');b.textContent='打包中…';});
  try{
    await flush();
    console.info('[project-package] client export start');
    const response=await fetch('/api/project-package');
    const result=await downloadBlob(response,`${safeName('工程')}.cutpot.zip`);
    console.info('[project-package] client export done',result);
    notify(`工程包已保存（含素材）：${result.fileName}`);
  }finally{buttons.forEach(b=>{b.disabled=false;b.removeAttribute('aria-busy');b.textContent='保存工程';});}
}

export async function importProjectFile(file,{revisions,onImported}){
  if(!file)return;
  const zip=isZipProject(file);
  if(zip&&file.size>8*1024**3)throw new Error('工程压缩包超过 8 GB');
  if(!zip&&file.size>32*1024*1024)throw new Error('工程文件超过 32 MB，请选择 CutPot JSON 或 .cutpot.zip 工程包');
  let preview={name:'未命名工程',shots:0,segments:0,clips:0,media:0,full:false,bundle:false};
  let jsonData=null;
  if(zip){
    preview={name:file.name.replace(/\.cutpot\.zip$/i,'').replace(/\.zip$/i,''),shots:0,segments:0,clips:0,media:0,full:true,bundle:true};
  }else{
    try{jsonData=JSON.parse(await file.text());}catch{throw new Error('工程文件不是有效 JSON，请重新选择');}
    const full=jsonData.format==='cutpot-project',project=full?jsonData.project:jsonData;
    if((full&&jsonData.version!==1)||project?.version!==1||!Array.isArray(project.clips))throw new Error('请选择 CutPot 保存的工程文件或工程包');
    preview={
      name:project.name||'未命名工程',
      shots:full?jsonData.creation?.shots?.length||0:0,
      segments:full?jsonData.creation?.segments?.length||0:0,
      clips:project.clips.length,
      media:full?(jsonData.assets||[]).filter(a=>a.file).length:0,
      full,bundle:Boolean(jsonData.bundle)
    };
  }
  const known=await revisions();
  let dialog=document.querySelector('#project-import-dialog');
  if(!dialog){dialog=document.createElement('dialog');dialog.id='project-import-dialog';document.body.append(dialog);}
  dialog.innerHTML='<h2>导入工程</h2><p class="project-import-name"></p><p class="project-import-counts"></p><p class="project-import-body"></p><p class="project-import-note"></p><p class="project-import-error" role="alert" hidden></p><div class="project-import-actions"><button type="button" data-import-cancel>取消</button><button type="button" class="primary" data-import-confirm>导入并打开</button></div>';
  dialog.querySelector('.project-import-name').textContent=preview.name||'未命名工程';
  dialog.querySelector('.project-import-counts').textContent=zip
    ?`工程压缩包 · ${file.size>1024**2?`${(file.size/1024**2).toFixed(1)} MB`:`${Math.max(1,Math.round(file.size/1024))} KB`}`
    :`${preview.full?`${preview.shots} 张分镜 · ${preview.segments} 个视频片段 · `:''}${preview.clips} 个剪辑镜头${preview.media?` · 包内素材 ${preview.media}`:''}`;
  dialog.querySelector('.project-import-body').textContent=zip
    ?'将解压并导入工程描述与素材图/视频，写入本机素材库后恢复三个页面。请先保存当前工作。'
    :'将替换当前工程。请先保存当前工作。旧版 JSON 仅含素材引用，所需媒体应已在本机素材库。';
  dialog.querySelector('.project-import-note').textContent=zip
    ?'推荐使用 .cutpot.zip：JSON 与素材一一对应，可迁移到其他电脑或项目。任务记录仅供查看，不会自动提交生成。'
    :preview.full?'兼容旧版 JSON 工程；三个页面一起恢复，但不会自动带入媒体文件。':'兼容旧版剪辑工程；同一工程现有分镜数据会保留。';
  dialog.querySelector('[data-import-cancel]').onclick=()=>dialog.close();
  const button=dialog.querySelector('[data-import-confirm]');
  button.onclick=async()=>{
    const error=dialog.querySelector('.project-import-error');error.hidden=true;button.disabled=true;button.textContent='导入中…';
    try{
      console.info('[project-package] client import start',{zip,name:file.name,bytes:file.size});
      const result=zip
        ?await request('/api/project-package',{method:'POST',headers:{'Content-Type':'application/zip','If-Match':known.editorRevision,'X-Cutpot-Creation-Revision':String(known.creationRevision)},body:file})
        :await request('/api/project-file',{method:'POST',headers:{'Content-Type':'application/json','If-Match':known.editorRevision,'X-Cutpot-Creation-Revision':String(known.creationRevision)},body:JSON.stringify(jsonData)});
      dialog.close();await onImported(result);
    }catch(e){error.textContent=e.message;error.hidden=false;}
    finally{button.disabled=false;button.textContent='导入并打开';}
  };
  dialog.showModal();
}
