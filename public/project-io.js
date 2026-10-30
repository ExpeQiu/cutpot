async function request(url,options){
  const response=await fetch(url,options),data=await response.json();
  if(!response.ok)throw new Error(data.error||'工程操作失败');
  return data;
}

export async function saveProjectFile({flush,notify}){
  const buttons=[...document.querySelectorAll('[data-action="download-project"]')];
  buttons.forEach(b=>{b.disabled=true;b.setAttribute('aria-busy','true');b.textContent='保存中…';});
  try{
    await flush();
    const data=await request('/api/project-file');
    const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
    if(blob.size>32*1024*1024)throw new Error('工程记录超过 32 MB，请先整理历史记录后再保存文件');
    const url=URL.createObjectURL(blob);
    const link=document.createElement('a');link.href=url;link.download=`${data.project.name.replace(/[\\/:*?"<>|]/g,'_')}.cutpot.json`;link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
    notify('工程已保存，包含分镜、视频版本与剪辑时间轴');
  }finally{buttons.forEach(b=>{b.disabled=false;b.removeAttribute('aria-busy');b.textContent='保存工程';});}
}

export async function importProjectFile(file,{revisions,onImported}){
  if(!file)return;
  if(file.size>32*1024*1024)throw new Error('工程文件超过 32 MB，请选择 CutPot JSON 工程');
  let data;try{data=JSON.parse(await file.text());}catch{throw new Error('工程文件不是有效 JSON，请重新选择');}
  const full=data.format==='cutpot-project',project=full?data.project:data;
  if((full&&data.version!==1)||project?.version!==1||!Array.isArray(project.clips))throw new Error('请选择 CutPot 保存的工程文件');
  const known=await revisions();
  let dialog=document.querySelector('#project-import-dialog');
  if(!dialog){dialog=document.createElement('dialog');dialog.id='project-import-dialog';document.body.append(dialog);}
  dialog.innerHTML='<h2>导入工程</h2><p class="project-import-name"></p><p class="project-import-counts"></p><p>将替换当前工程。请先保存当前工作。工程只包含素材引用，所需图片、视频和音频应已存在于本机素材库。</p><p class="project-import-note"></p><p class="project-import-error" role="alert" hidden></p><div class="project-import-actions"><button type="button" data-import-cancel>取消</button><button type="button" class="primary" data-import-confirm>导入并打开</button></div>';
  dialog.querySelector('.project-import-name').textContent=project.name||'未命名工程';
  dialog.querySelector('.project-import-counts').textContent=`${full?`${data.creation?.shots?.length||0} 张分镜 · ${data.creation?.segments?.length||0} 个视频片段 · `:''}${project.clips.length} 个剪辑镜头`;
  dialog.querySelector('.project-import-note').textContent=full?'三个页面的数据一起恢复。任务记录仅供查看，导入不会自动提交或恢复生成。':'兼容旧版剪辑工程；同一工程现有分镜数据会保留。';
  dialog.querySelector('[data-import-cancel]').onclick=()=>dialog.close();
  const button=dialog.querySelector('[data-import-confirm]');
  button.onclick=async()=>{
    const error=dialog.querySelector('.project-import-error');error.hidden=true;button.disabled=true;button.textContent='导入中…';
    try{
      const result=await request('/api/project-file',{method:'POST',headers:{'Content-Type':'application/json','If-Match':known.editorRevision,'X-Cutpot-Creation-Revision':String(known.creationRevision)},body:JSON.stringify(data)});
      dialog.close();await onImported(result);
    }catch(e){error.textContent=e.message;error.hidden=false;}
    finally{button.disabled=false;button.textContent='导入并打开';}
  };
  dialog.showModal();
}
