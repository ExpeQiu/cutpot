import {saveProjectFile,importProjectFile,createNewProject} from './project-io.js';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shapes = {
 image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="2"/><path d="m21 15-5-5L5 21"/>',
 film: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18m10-18v18M3 8h4m10 0h4M3 16h4m10 0h4"/>',
 plus: '<path d="M12 5v14M5 12h14"/>', arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
 play: '<path d="m8 4 12 8-12 8Z"/>', settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
 upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5"/>', download: '<path d="M12 3v13m-5-5 5 5 5-5M4 20h16"/>', check: '<path d="m5 12 4 4L19 6"/>', book: '<path d="M4 4h6l2 2 2-2h6v16h-6l-2 2-2-2H4Zm8 2v16"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shapes[name] || shapes.image}</svg>`;
const page = location.pathname === '/videos' ? 'video' : 'image';
const kind = page;
let S, selected = null, selectedIds = new Set(), filter = 'all', query = '', error = '', busy = false, uploadTarget, sequence = [], sequenceIndex = 0, sequencePlaying = false, lastSignature = '', providerMenuOpen = false;
const videoProviders = Object.freeze([['dreamina', '即梦 CLI · 视频', '点击生成会消耗即梦积分 · 时长建议 4–10 秒'], ['autodl', 'AutoDL · 视频', '点击生成会使用算力服务']]);
const drafts = new Map();
const labels = { pending: '待生成', queued: '排队中', running: '生成中', completed: '已完成', failed: '失败', interrupted: '待查询', cancelled: '已停止', stale: '待更新', approved: '已通过', rejected: '需返工' };
const items = () => kind === 'image' ? S.shots : S.segments;
const current = () => items().find(s => s.id === selected);
const version = item => item?.versions.find(v => v.id === item.selectedVersionId);
const asset = id => S.assets.find(a => a.id === id);
const content = id => `/api/assets/${id}/content`;
const thumb = id => asset(id)?.thumbnail || content(id);
const shotNumber = id => S.shots.findIndex(x => x.id === id) + 1;
const num = n => String(n).padStart(2, '0');
const nameOf = item => kind === 'image' ? item.title : `片段 ${num(S.segments.indexOf(item) + 1)}`;
const lastJob = id => [...S.jobs].reverse().find(j => j.targetId === id);
const generationBlocked = item => ['queued','running'].includes(item.status) || item.status==='interrupted' && Boolean(lastJob(item.id)?.externalId);
const status = item => item.stale && !['running', 'queued'].includes(item.status) ? 'stale' : item.status;
const badge = (state, label) => `<span class="status ${state}">${esc(label || labels[state] || state)}</span>`;
const bytes = n => n ? n > 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.round(n / 1024)} KB` : '—';
const quality = item => { const v = version(item); return item.stale ? 'stale' : v?.review === 'rejected' ? 'bad' : v?.firstPSNR == null || v?.lastPSNR == null ? '' : Math.min(v.firstPSNR, v.lastPSNR) < 15 ? 'bad' : Math.min(v.firstPSNR, v.lastPSNR) < 23 ? 'warn' : 'good'; };
function notify(message) { $('#notice').textContent = message; $('#notice').classList.add('show'); clearTimeout(notify.timer); notify.timer = setTimeout(() => $('#notice').classList.remove('show'), 4500); }
async function api(url, options = {}) { const r = await fetch(url, options), data = await r.json(); if (!r.ok) throw new Error(data.error || '请求失败'); return data; }
async function refresh(renderPage = true) {
  S = await api('/api/pipeline');
  if (!items().some(x => x.id === selected)) selected = items()[0]?.id || null;
  selectedIds = new Set([...selectedIds].filter(id => items().some(x => x.id === id)));
  if (renderPage) render();
}
async function commit(payload, renderPage = true) {
  S = await api('/api/pipeline', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, projectId: S.projectId, revision: S.revision }) });
  error = '';
  if (!items().some(x => x.id === selected)) selected = items()[0]?.id || null;
  if (renderPage) render();
  return S;
}
function snapshotDraft() {
  const form = $('#item-form');
  if (form && selected) {
    const data=Object.fromEntries(new FormData(form)), base=current();
    if (Object.entries(data).some(([k,v])=>String(base?.[k]??'')!==String(v))) drafts.set(selected,data); else drafts.delete(selected);
  }
  if ($('#script')) {
    const data={script:$('#script').value,style:$('#style').value};
    if(data.script!==S.script||data.style!==S.style)drafts.set('script',data);else drafts.delete('script');
  }
}
async function saveItem(renderPage = false) {
  snapshotDraft();
  const item = current(), draft = drafts.get(selected);
  if (!item || !draft) return;
  await commit({ action: kind === 'image' ? 'shot' : 'segment', id: selected, ...draft }, false);
  drafts.delete(selected);
  if (renderPage) render();
}
function select(id) {
  snapshotDraft(); selected = id;
  if (sequencePlaying) stopSequence();
  render();
}
async function saveAllDrafts(){
  snapshotDraft();
  for(const [id,data] of [...drafts]){
    if(id==='script')await commit({action:'script',...data},false);
    else await commit({action:S.shots.some(s=>s.id===id)?'shot':'segment',id,...data},false);
    drafts.delete(id);
  }
}
function header() {
  return `<header class="topbar"><a class="brand" href="/storyboard"><span class="brand-mark">C</span><span>CutPot<small>VIDEO WORKSPACE</small></span></a><div class="project-label"><span>项目 /</span><button class="project-title ghost small" data-action="rename" title="重命名项目">${esc(S.name)}</button>${S.projectDir ? `<small class="project-dir" title="${esc(S.projectDir)}">${esc(S.projectDir)}</small>` : ''}</div><nav class="workflow-nav" aria-label="创作流水线">${[['/storyboard', '01', '分镜图创作', 'image'], ['/videos', '02', '首尾帧视频', 'video'], ['/editor', '03', '剪辑导出', 'editor']].map(([url, step, title, id]) => `<a href="${url}" ${id === page ? 'aria-current="page"' : ''}><span class="step-number">${step}</span>${title}</a>`).join('')}</nav><div class="spacer"></div><div class="project-file-actions" role="group" aria-label="工程文件"><button class="small" data-action="new-project">新增项目</button><button class="small" data-action="download-project">保存工程</button><button class="small" data-action="open-project">导入工程</button></div><span class="mode-tag ${S.settings.mode}">${S.settings.mode === 'mock' ? '模拟模式' : '真实生成'}</span><button class="ghost small" data-action="settings">${icon('settings')}生成设置</button></header>`;
}
function videoProvider() { return S.settings.videoProvider || 'autodl'; }
function providerMeta(provider = videoProvider()) { return videoProviders.find(([id]) => id === provider) || videoProviders[1]; }
function providerLabel(provider = videoProvider()) { return providerMeta(provider)[1]; }
function providerHint(provider = videoProvider()) {
  if (S.settings.mode === 'mock') return '当前只生成本地模拟素材';
  return providerMeta(provider)[2];
}
function stats() {
  const list = items(), finished = list.filter(x => version(x)).length, running = list.filter(x => ['running', 'queued'].includes(x.status)).length;
  const metrics = kind === 'image' ? [[list.length, '总分镜', ''], [finished, '已有图片', 'good'], [running, '生成与排队', ''], [list.filter(x => x.status === 'failed').length, '生成失败', 'bad'], [list.length - finished, '待补齐', 'warn']] : [[list.length, '视频片段', ''], [list.filter(x => quality(x) === 'good').length, '首尾帧贴合', 'good'], [list.filter(x => x.stale || quality(x) === 'warn').length, '需复查', 'warn'], [list.filter(x => quality(x) === 'bad').length, '低贴合或返工', 'bad'], [`${list.reduce((a, x) => a + x.duration, 0).toFixed(1)}s`, '计划总时长', ''], [bytes(list.reduce((a, x) => a + (version(x)?.size || 0), 0)), '选用视频体积', '']];
  const aside = kind === 'image'
    ? `<div class="stat aside-stat">${icon('image')}<div><strong>即梦 · 图片创作</strong><span>${S.settings.mode === 'mock' ? '当前只生成本地模拟素材' : '点击生成会消耗即梦积分'}</span></div></div>`
    : `<div class="stat aside-stat provider-stat ${providerMenuOpen ? 'open' : ''}" aria-label="视频生成路径"><button type="button" class="provider-trigger" data-provider-menu="toggle" aria-expanded="${providerMenuOpen}" aria-haspopup="listbox"><span class="provider-trigger-main">${icon('film')}<span><strong>${esc(providerLabel())}</strong><span>${esc(providerHint())}</span></span></span><span class="provider-caret" aria-hidden="true"></span></button><div class="provider-menu" role="listbox" aria-label="选择视频生成路径">${videoProviders.map(([id, title, hint]) => `<button type="button" role="option" class="${videoProvider() === id ? 'selected' : ''}" data-video-provider="${id}" aria-selected="${videoProvider() === id}"><strong>${esc(title)}</strong><span>${esc(S.settings.mode === 'mock' ? '模拟模式下不调用该服务' : hint)}</span></button>`).join('')}</div></div>`;
  return `<div class="stats">${metrics.map(([value, title, cls]) => `<div class="stat ${cls}"><strong>${value}</strong><span>${title}</span></div>`).join('')}${aside}</div>`;
}
function references() {
  return `<section class="panel reference-panel" aria-label="主体参考图"><div class="panel-head"><h2>主体参考图</h2><small>所有分镜共用 · ${S.references.length}/10</small><span class="spacer"></span><button class="ghost small" data-action="reference-library">从素材库选择</button></div><div class="references">${S.references.map(id => `<div class="reference"><img src="${thumb(id)}" alt="${esc(asset(id)?.name || '主体参考图')}"><button class="remove small" data-remove-reference="${id}" aria-label="移除参考图">×</button></div>`).join('')}<button class="reference-add" data-action="upload-reference" ${S.references.length >= 10 ? 'disabled' : ''}>${icon('plus')}上传参考图</button><p class="reference-copy">添加人物、服装或场景参考。生成时将一起发送给即梦，帮助不同镜头保持一致。</p></div></section>`;
}
function scriptPanel() {
  const draft = drafts.get('script') || S;
  return `<section class="panel script-panel"><div class="panel-head"><h2>故事脚本</h2><small>从故事开始，逐镜完善</small><span class="spacer"></span><button class="ghost small" data-action="archives">分镜历史 ${S.archives.length ? `(${S.archives.length})` : ''}</button></div><div class="script-layout"><div><label for="script">完整脚本</label><textarea id="script" rows="3" maxlength="50000" placeholder="输入完整脚本。用空行分段，或按句子拆成连续分镜…">${esc(draft.script)}</textarea><div class="script-tools"><div class="field"><label for="shot-count">目标分镜数</label><input id="shot-count" type="number" min="1" max="100" value="${S.shots.length || 8}"></div><button class="primary" data-action="split">${icon('book')}拆分分镜</button><button class="ghost" data-action="save-script">保存脚本</button><span class="hint">按段落与句子拆分，保留原文，可逐镜编辑。</span></div></div><div class="stack"><div><label for="style">统一画面风格</label><textarea id="style" rows="3" maxlength="4000" placeholder="例如：三维动画，柔和自然光，保持角色服装一致">${esc(draft.style)}</textarea><p class="hint">生成分镜图时自动附加到每个提示词。</p></div></div></div></section>`;
}
function empty(title, description, action, button, compact = false) { return `<div class="empty ${compact ? 'compact' : ''}">${icon(kind === 'image' ? 'image' : 'film')}<h3>${title}</h3><p>${description}</p>${action ? `<button class="primary" data-action="${action}">${button}</button>` : ''}</div>`; }
function tools() {
  return `<div class="list-tools"><select id="filter" aria-label="筛选状态">${[['all', '全部状态'], ['pending', '待生成'], ['completed', '已完成'], ['running', '生成与排队'], ['failed', '失败'], ...(kind === 'video' ? [['stale', '待更新'], ['review', '需复查']] : [])].map(([v, name]) => `<option value="${v}" ${filter === v ? 'selected' : ''}>${name}</option>`).join('')}</select><input id="search" value="${esc(query)}" placeholder="搜索${kind === 'image' ? '分镜' : '片段'}…" aria-label="搜索"><button class="ghost small" data-action="select-visible">全选可见项</button><button class="ghost small" data-action="clear-selection">取消选择</button><span class="count">${selectedIds.size ? `已选 ${selectedIds.size} 项` : `${items().length} 项`}</span></div>`;
}
function visibleItems() { return items().filter(item => (filter === 'all' || filter === 'running' && ['running', 'queued'].includes(item.status) || filter === 'review' && ['warn', 'bad'].includes(quality(item)) || status(item) === filter) && `${nameOf(item)} ${item.prompt}`.toLowerCase().includes(query.toLowerCase())); }
function imageThumb(v, alt, cls = 'thumb') { return v ? `<img class="${cls}" src="${thumb(v.assetId)}" alt="${esc(alt)}">` : `<div class="${cls}">${icon('image')}</div>`; }
function listCards() {
  const list = visibleItems();
  if (!items().length) return kind === 'image' ? empty('从第一个画面开始', '输入故事并拆分分镜，或导入已有分镜图。你也可以载入乐乐示例，体验整条创作流程。', 'demo', '载入乐乐示例') : empty('先准备一组连续画面', '至少两张分镜图构成一个首尾帧片段。回到分镜图页面，生成或导入关键画面。', 'go-storyboard', '前往分镜图创作');
  if (!list.length) return empty('没有匹配项', '调整状态筛选或搜索内容，查看其他分镜。', 'reset-filter', '查看全部', true);
  return list.map(item => {
    const v = version(item), j = lastJob(item.id), n = items().indexOf(item) + 1;
    const first = kind === 'video' ? version(S.shots.find(x => x.id === item.fromShotId)) : null;
    const last = kind === 'video' ? version(S.shots.find(x => x.id === item.toShotId)) : null;
    return `<article class="shot-card ${kind === 'video' ? 'segment-card' : ''} ${selected === item.id ? 'selected' : ''}" data-select="${item.id}" tabindex="0" aria-label="选择${esc(nameOf(item))}"><header><input type="checkbox" data-check="${item.id}" ${selectedIds.has(item.id) ? 'checked' : ''} aria-label="选择${esc(nameOf(item))}用于批量操作"><span class="index">${kind === 'image' ? num(n) : `seg_${num(n)}`}</span><h3>${esc(kind === 'image' ? item.title : `${num(shotNumber(item.fromShotId))} → ${num(shotNumber(item.toShotId))}`)}</h3>${kind === 'video' ? `<small>${item.duration}s</small>` : ''}<span class="spacer"></span>${badge(status(item))}</header><div class="card-content">${kind === 'image' ? imageThumb(v, item.title) : `<div class="pair">${imageThumb(first, '首帧')}${icon('arrow')}${imageThumb(last, '尾帧')}</div>`}<div class="card-copy"><p>${esc(item.prompt || '点击编辑画面提示词')}</p><div class="card-foot">${v ? `<span>${v.mode === 'mock' ? '模拟素材' : v.mode === 'imported' ? '已导入' : '真实生成'} · ${item.versions.length} 个版本</span>` : '<span>尚未选用素材</span>'}${kind === 'video' && v ? `<span>${bytes(v.size)}</span>${v.review === 'approved' ? badge('approved') : v.review === 'rejected' ? badge('rejected') : ''}` : ''}<span class="spacer"></span><button class="ghost small" data-edit="${item.id}">编辑</button><button class="ghost small" data-import="${item.id}">导入${kind === 'image' ? '图片' : '视频'}</button><button class="small" data-generate="${item.id}" ${generationBlocked(item) ? 'disabled' : ''}>${v ? '重新生成' : '生成'}</button></div>${j && ['running', 'queued'].includes(j.status) ? `<div class="progress"><span style="width:${j.progress}%"></span></div><div class="job-brief">${esc(j.message)}</div>` : ''}${j && ['failed', 'interrupted'].includes(j.status) ? `<div class="inline-error">${esc(j.message)}${j.externalId && j.status === 'interrupted' ? ` <button class="small" data-resume="${j.id}">继续查询</button>` : ''}</div>` : ''}</div></div></article>`;
  }).join('');
}
function versionStrip(item) {
  if (!item.versions.length) return '';
  const latestJob = [...item.versions].reverse().find(v => v.jobId)?.jobId;
  const hasHistory = latestJob && item.versions.some(v => v.jobId && v.jobId !== latestJob);
  const selectedIndex = item.versions.findIndex(v => v.id === item.selectedVersionId);
  return `<div class="versions" aria-label="候选与历史版本">${item.versions.map((v, i) => {
    const fresh = hasHistory && v.jobId === latestJob;
    return `<button class="version ${fresh ? 'fresh' : ''}" data-version="${v.id}" aria-pressed="${v.id === item.selectedVersionId}">${imageThumb(v, `版本 ${i + 1}`, '')}<span>版本 ${i + 1}${fresh ? ' · 本批' : ''}</span></button>`;
  }).join('')}</div><p class="hint version-strip-hint">共 ${item.versions.length} 个版本${selectedIndex >= 0 ? ` · 当前选用版本 ${selectedIndex + 1}` : ''}。重新生成会保留旧候选并追加新图；可点版本 1 / 2 切回。</p>`;
}
function inspector() {
  const item = current();
  if (!item) return `<aside class="panel inspector">${empty('逐镜打磨', '选中左侧分镜，在这里调整提示词、预览素材和选择版本。', null, null, true)}</aside>`;
  const v = version(item), d = drafts.get(selected) || item;
  const media = v ? kind === 'image' ? `<img src="${content(v.assetId)}" alt="${esc(item.title)}">` : `<video id="clip-video" controls playsinline preload="metadata" src="${content(v.assetId)}"></video>` : `<div class="media-empty">${icon(kind === 'image' ? 'image' : 'film')}生成或导入后，在这里预览${kind === 'image' ? '分镜图' : '视频'}</div>`;
  const first = kind === 'video' ? version(S.shots.find(x => x.id === item.fromShotId)) : null, last = kind === 'video' ? version(S.shots.find(x => x.id === item.toShotId)) : null;
  const durationMin = kind === 'video' && videoProvider() === 'dreamina' ? 4 : 1;
  const generateLabel = S.settings.mode === 'mock' ? '模拟生成' : kind === 'image' ? '即梦生成' : videoProvider() === 'dreamina' ? '即梦生成' : 'AutoDL 生成';
  return `<aside class="panel inspector"><div class="panel-head"><h2>${kind === 'image' ? `分镜 ${num(items().indexOf(item) + 1)}` : `seg_${num(items().indexOf(item) + 1)}`}</h2><span class="spacer"></span>${badge(status(item))}</div><div class="panel-body">${item.stale ? '<div class="inline-warning">首尾帧或生成参数已变更。当前视频保留原版本，更新后再送入剪辑。</div>' : ''}<div class="media-preview">${media}${v?.mode === 'mock' ? '<span class="media-label">模拟素材</span>' : ''}</div>${versionStrip(item)}${kind === 'video' ? `<div class="pair-preview"><div><label>首帧 · ${num(shotNumber(item.fromShotId))}</label>${first ? `<img src="${content(first.assetId)}" alt="首帧">` : '<p class="hint">缺少首帧</p>'}</div><div><label>尾帧 · ${num(shotNumber(item.toShotId))}</label>${last ? `<img src="${content(last.assetId)}" alt="尾帧">` : '<p class="hint">缺少尾帧</p>'}</div></div><div class="quality-scores">${[['firstPSNR', '首帧 PSNR'], ['lastPSNR', '尾帧 PSNR']].map(([key, label]) => `<div class="quality-score"><strong>${v?.[key] == null ? '—' : v[key] >= 100 ? '∞' : v[key].toFixed(1)}</strong><small>${label} · dB</small></div>`).join('')}</div><p class="hint">仅衡量与参考帧的像素贴合程度。23 / 15 dB 为复查线索，角色、动作与衔接仍需观看检查。${v?.qualityError ? '本次指标计算失败，视频已保留。' : ''}</p>${v ? `<div class="review-options">${[['pending', '待检查'], ['approved', '检查通过'], ['rejected', '需要返工']].map(([review, title]) => `<button class="${v.review === review ? 'selected' : ''}" data-review="${review}">${title}</button>`).join('')}</div>` : ''}` : ''}<form id="item-form">${kind === 'image' ? `<div class="field"><label for="item-title">分镜标题</label><input id="item-title" name="title" maxlength="200" value="${esc(d.title)}"></div><div class="field"><label for="item-description">脚本原文</label><textarea id="item-description" name="description" rows="2">${esc(d.description)}</textarea></div>` : `<div class="field"><label for="item-duration">片段时长（秒）</label><input id="item-duration" name="duration" type="number" min="${durationMin}" max="10" step="0.1" value="${d.duration}"><p class="hint">${videoProvider() === 'dreamina' ? '即梦路径要求 4–15 秒，当前上限 10 秒。' : '可按片段节奏调整时长。'}</p></div>`}<div class="field"><label for="item-prompt">${kind === 'image' ? '画面提示词' : '动作与运镜提示词'}</label><textarea id="item-prompt" name="prompt" rows="${kind === 'image' ? 4 : 5}" maxlength="12000">${esc(d.prompt)}</textarea></div>${kind === 'image' ? `<div class="field"><label for="item-negative">避免出现的内容</label><textarea id="item-negative" name="negativePrompt" rows="2" maxlength="4000" placeholder="例如：服装变化，多余手指，画面文字">${esc(d.negativePrompt)}</textarea></div>` : ''}<div class="inspector-actions"><button type="submit">保存修改</button><button type="button" class="primary" data-generate="${item.id}" ${generationBlocked(item) ? 'disabled' : ''}>${generateLabel}</button></div></form><div class="inspector-actions"><button class="ghost small" data-import="${item.id}">从素材库导入</button>${v ? `<a class="small" href="${content(v.assetId)}" download="${esc(asset(v.assetId)?.name || '素材')}">下载素材 ↗</a>` : ''}</div>${kind === 'image' ? `<div class="inspector-actions"><button class="small ghost" data-move="up" ${S.shots[0]?.id === item.id ? 'disabled' : ''}>↑ 前移</button><button class="small ghost" data-move="down" ${S.shots.at(-1)?.id === item.id ? 'disabled' : ''}>↓ 后移</button></div>` : ''}${v ? `<div class="version-meta">${v.mode === 'mock' ? '本地模拟素材' : v.mode === 'imported' ? '导入素材' : `生成服务：${kind === 'image' ? '即梦' : 'AutoDL'}`}<br>${v.externalId ? `任务编号：${esc(v.externalId)}<br>` : ''}${new Date(v.createdAt).toLocaleString('zh-CN')} · ${bytes(v.size)}</div>` : ''}</div></aside>`;
}
function frameNavigation() {
  return `<section class="panel frame-nav"><div class="filmstrip" aria-label="分镜图片导航">${S.shots.map((shot, i) => { const v = version(shot), seg = current(); return `<button class="frame-cell ${seg && [seg.fromShotId, seg.toShotId].includes(shot.id) ? 'selected' : ''}" data-frame="${shot.id}">${v ? `<img src="${thumb(v.assetId)}" alt="${esc(shot.title)}">` : '<span class="missing">待生图</span>'}<span>${num(i + 1)}</span></button>`; }).join('') || '<p class="hint">准备分镜图后，将在这里显示完整画面序列。</p>'}</div><div class="segment-strip" aria-label="视频片段导航">${S.segments.map(seg => `<button class="segment-pill ${selected === seg.id ? 'selected' : ''}" data-segment="${seg.id}">${num(shotNumber(seg.fromShotId))} → ${num(shotNumber(seg.toShotId))}</button>`).join('')}</div></section>`;
}
function sequencePanel() {
  const ready = S.segments.filter(s => version(s) && !s.stale);
  return `<section class="panel sequence-panel"><div class="panel-head"><h2>连续预览</h2><small>按片段顺序播放 · 缺失或待更新片段会跳过</small><span class="spacer"></span><small id="sequence-label">${ready.length}/${S.segments.length} 段可播放</small></div><div class="sequence-body"><div class="sequence-stage" id="sequence-stage"><div class="sequence-empty">${icon('play')}<span>${ready.length ? '检查动作、角色与镜头之间的衔接' : '生成视频后，在这里连播检查'}</span></div></div><div class="sequence-controls"><button class="primary" data-action="play-sequence" ${!ready.length ? 'disabled' : ''}>${icon('play')}开始连播</button><button class="ghost small" data-action="stop-sequence">停止</button><div class="number-grid">${S.segments.map((seg, i) => `<button data-play-segment="${seg.id}" ${!version(seg) || seg.stale ? 'disabled' : ''}>${num(i + 1)}</button>`).join('')}</div></div></div><div class="quality-line" aria-label="片段质量概览">${S.segments.map((seg, i) => `<button class="quality-block ${quality(seg)}" data-segment="${seg.id}" title="片段 ${i + 1} · ${labels[status(seg)]}" aria-label="选择片段 ${i + 1}"></button>`).join('')}</div></section>`;
}
function render() {
  if (!S) return;
  const ready = S.shots.filter(s => version(s)).length;
  document.title = `CutPot · ${kind === 'image' ? '分镜图创作' : '首尾帧视频创作'}`;
  const segmentsReady = S.segments.length && !S.segments.some(s => !version(s) || s.stale);
  $('#app').innerHTML = `${header()}<main class="page" id="workspace"><div class="page-heading"><div><div class="eyebrow">${kind === 'image' ? 'STORYBOARD / 01' : 'MOTION / 02'}</div><h1>${kind === 'image' ? '让故事有画面' : '让画面连成故事'}</h1><p>${kind === 'image' ? '拆分脚本，保持主体一致，逐镜选择满意的画面。' : '用相邻分镜作为首尾帧，生成片段，再检查整条故事的衔接。'}</p></div><div class="page-actions">${kind === 'image' ? `<button data-action="export-shots">${icon('download')}导出分镜流</button><button data-action="upload-shots">${icon('upload')}导入分镜图</button><button class="primary" data-action="go-videos" ${ready < 2 ? 'disabled' : ''}>下一步 · 首尾帧视频 ${icon('arrow')}</button>` : `<button data-action="go-storyboard">← 返回分镜图</button><button data-action="export-segments" ${segmentsReady ? '' : 'disabled'}>${icon('download')}导出拼接视频</button><button class="primary" data-action="handoff" ${segmentsReady ? '' : 'disabled'}>送入 CutPot 剪辑 ${icon('arrow')}</button>`}</div></div>${stats()}${error ? `<div class="inline-error" role="alert">${esc(error)} <button class="ghost small" data-action="refresh">刷新数据</button></div>` : ''}${kind === 'image' ? references() + scriptPanel() : frameNavigation() + sequencePanel()}<div class="row spread wrap" style="margin-bottom:16px"><h2>${kind === 'image' ? '分镜画面' : '视频片段'} <small>${items().length} ${kind === 'image' ? '个分镜' : '个片段'}</small></h2><div class="row"><button class="ghost small" data-action="jobs">任务记录 ${S.jobs.filter(j => ['queued', 'running', 'interrupted'].includes(j.status)).length || ''}</button>${kind === 'image' ? '<button class="ghost small" data-action="add-shot">＋ 新增分镜</button>' : ''}<button class="ghost small" data-action="stop-queue" ${S.jobs.some(j => j.status === 'queued') ? '' : 'disabled'}>停止排队</button><button class="primary" data-action="generate-batch" ${!items().length ? 'disabled' : ''}>${selectedIds.size ? `生成所选 ${selectedIds.size} 项` : '生成待完成项'}</button></div></div><div class="workspace-grid"><section aria-label="${kind === 'image' ? '分镜列表' : '片段列表'}">${tools()}<div class="shot-list" id="item-list">${listCards()}</div></section>${inspector()}</div><footer class="footer"><span class="dot"></span><span>已保存到本机 · ${S.settings.mode === 'mock' ? '模拟生成不会调用付费服务' : '真实任务仅在点击生成后提交'}</span><span class="spacer"></span><a href="/editor">打开剪辑工作台 ↗</a><span>CutPot 0.9</span></footer></main>`;
  lastSignature = signature(S);
}
function modal(html) { const d = $('#modal'); d.innerHTML = html; if (!d.open) d.showModal(); }
const closeButton = '<button data-action="close-modal">关闭</button>';
function settings() {
  modal(`<h2>生成设置</h2><p>图片固定走即梦；视频可在即梦 CLI 首尾帧与 AutoDL 首尾帧之间切换。模拟模式在本机生成带标记的测试素材，帮助你检查完整操作流程。</p><form id="settings-form"><div class="field"><label for="mode">服务模式</label><select name="mode" id="mode"><option value="mock" ${S.settings.mode === 'mock' ? 'selected' : ''}>模拟模式 · 不调用付费服务</option><option value="live" ${S.settings.mode === 'live' ? 'selected' : ''}>真实生成 · 点击生成会消耗积分或算力</option></select></div><div class="field"><label for="videoProvider">视频生成路径</label><select name="videoProvider" id="videoProvider"><option value="autodl" ${videoProvider() === 'autodl' ? 'selected' : ''}>AutoDL · 视频（首尾帧）</option><option value="dreamina" ${videoProvider() === 'dreamina' ? 'selected' : ''}>即梦 CLI · 视频（frames2video）</option></select></div><div class="field-grid"><div class="field"><label>画幅</label><select name="ratio">${['16:9', '9:16', '1:1'].map(r => `<option ${r === S.settings.ratio ? 'selected' : ''}>${r}</option>`).join('')}</select></div><div class="field"><label>即梦图片分辨率</label><select name="resolution">${['2k', '4k'].map(r => `<option ${r === S.settings.resolution ? 'selected' : ''}>${r}</option>`).join('')}</select></div></div><div class="field"><label>每镜图片候选数</label><select name="candidates">${[1, 2, 4, 6, 8, 10].map(n => `<option ${n === S.settings.candidates ? 'selected' : ''}>${n}</option>`).join('')}</select></div><p class="hint">真实模式复用本机 dreamina 与 autodl-cli 的登录和连接配置。服务不可用时显示失败原因，不自动改走另一路径。即梦视频时长须 4–15 秒。</p><div class="dialog-actions">${closeButton}<button class="primary" type="submit">保存设置</button></div></form>`);
}
function library(target, type = kind) {
  uploadTarget = target;
  const list = S.assets.filter(a => a.type === (type === 'image' ? 'image' : 'video'));
  modal(`<h2>${target === 'reference' ? '选择主体参考图' : `导入${type === 'image' ? '分镜图' : '视频'}`}</h2><p>选择已导入的素材，或上传新文件。候选版本会保留。</p><div class="asset-picker">${list.map(a => `<button class="asset-option" data-asset="${a.id}">${a.thumbnail ? `<img src="${a.thumbnail}" alt="${esc(a.name)}">` : icon('film')}<span>${esc(a.name)}</span></button>`).join('') || '<p class="hint">素材库还没有可用素材。</p>'}</div><div class="dialog-actions">${closeButton}<button class="primary" data-action="upload-current">${icon('upload')}上传文件</button></div>`);
}
function askConfirm(title, description, button, onAccept) {
  modal(`<h2>${title}</h2><p>${description}</p><div class="dialog-actions">${closeButton}<button class="primary" id="accept-action">${button}</button></div>`);
  $('#accept-action').onclick = () => runAction(async () => { $('#modal').close(); await onAccept(); });
}
function openUpload(target, type = 'image', multiple = true) {
  uploadTarget = target; $('#upload').accept = type === 'image' ? 'image/png,image/jpeg,image/webp' : 'video/mp4,video/webm,video/quicktime'; $('#upload').multiple = multiple; $('#upload').click();
}
async function attach(id) {
  if (uploadTarget === 'reference') { await commit({ action: 'references', assetIds: [...new Set([...S.references, id])] }); }
  else await commit({ action: 'attach', kind, id: uploadTarget, assetId: id });
}
async function generateItems(ids) {
  if (!ids.length) return notify('没有待生成项；可勾选已有项重新生成。');
  if (drafts.has(selected) && ids.includes(selected)) await saveItem(false);
  if (kind === 'image' && drafts.has('script')) {
    const d = drafts.get('script'); await commit({ action: 'script', ...d }, false); drafts.delete('script');
  }
  await commit({ action: 'generate', kind, ids, authorizeLive: S.settings.mode === 'live' });
  notify(`${ids.length} 项已加入${S.settings.mode === 'mock' ? '模拟' : '真实生成'}队列`);
}
function startSequence(id) {
  sequence = S.segments.filter(s => version(s) && !s.stale);
  sequenceIndex = id ? sequence.findIndex(s => s.id === id) : 0;
  if (sequenceIndex < 0 || !sequence.length) return;
  sequencePlaying = true; playSequenceItem();
}
function playSequenceItem() {
  const item = sequence[sequenceIndex]; if (!item) return stopSequence();
  selected = item.id;
  if($('.inspector'))$('.inspector').outerHTML=inspector();
  document.querySelectorAll('[data-select]').forEach(el=>el.classList.toggle('selected',el.dataset.select===item.id));
  document.querySelectorAll('[data-segment]').forEach(el=>el.classList.toggle('selected',el.dataset.segment===item.id));
  $('#sequence-stage').innerHTML = `<video id="sequence-video" controls playsinline src="${content(version(item).assetId)}"></video>`;
  $('#sequence-label').textContent = `正在播放 ${num(S.segments.indexOf(item) + 1)} / ${S.segments.length}${version(item).mode === 'mock' ? ' · 模拟素材' : ''}`;
  document.querySelectorAll('[data-play-segment]').forEach(b => b.classList.toggle('selected', b.dataset.playSegment === item.id));
  const video = $('#sequence-video');
  video.onended = () => { sequenceIndex++; if (sequenceIndex < sequence.length) playSequenceItem(); else stopSequence(); };
  video.onerror = () => { sequencePlaying = false; error = '片段无法播放，请检查素材格式或重新导入 H.264 MP4。'; notify(error); };
  video.play().catch(() => { notify('请点击播放器播放，浏览器阻止了自动播放。'); });
}
function stopSequence() { sequencePlaying = false; $('#sequence-video')?.pause(); }
async function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.readAsDataURL(blob);
  });
}
async function imageDataUrl(assetId) {
  if (!assetId) return '';
  const res = await fetch(content(assetId));
  if (!res.ok) throw new Error(`分镜图读取失败（${assetId}）`);
  return blobToDataUrl(await res.blob());
}
function safeFileName(name) {
  return String(name || '分镜流').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || '分镜流';
}
function buildStoryboardHtml(shots, images, meta) {
  const shotBlocks = shots.map((shot, i) => {
    const n = num(i + 1);
    const img = images[i];
    const fields = [
      ['脚本原文', shot.description],
      ['画面提示词', shot.prompt],
      ['避免出现', shot.negativePrompt]
    ].filter(([, text]) => String(text || '').trim());
    return `<article class="shot" id="shot-${n}">
  <header class="shot-head"><span class="shot-index">${n}</span><h2>${esc(shot.title || `分镜 ${n}`)}</h2></header>
  <div class="shot-media">${img ? `<img src="${img}" alt="${esc(shot.title || `分镜 ${n}`)}">` : '<div class="missing">暂无选用分镜图</div>'}</div>
  <div class="shot-fields">${fields.map(([label, text]) => `<section><h3>${label}</h3><pre>${esc(text)}</pre></section>`).join('') || '<p class="empty-copy">本镜尚未填写描述词</p>'}</div>
</article>`;
  }).join('\n');
  const toc = shots.map((shot, i) => {
    const n = num(i + 1);
    return `<a href="#shot-${n}"><span>${n}</span>${esc(shot.title || `分镜 ${n}`)}</a>`;
  }).join('');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(meta.name)} · 分镜流确认稿</title>
<style>
:root{color-scheme:light;--ink:#1c1d1a;--muted:#5f6358;--line:#d7d9d0;--panel:#f4f5f0;--accent:#4d6a1f}
*{box-sizing:border-box}body{margin:0;font:15px/1.6 "PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;color:var(--ink);background:#fff}
.wrap{max-width:880px;margin:0 auto;padding:32px 20px 64px}
header.cover{border-bottom:1px solid var(--line);padding-bottom:24px;margin-bottom:28px}
.eyebrow{color:var(--accent);font-size:12px;letter-spacing:.12em;margin:0 0 8px}
h1{font-size:28px;line-height:1.25;margin:0 0 8px}
.meta{color:var(--muted);margin:0;font-size:13px}
.style-box,.script-box{margin-top:16px;padding:14px 16px;background:var(--panel);border-radius:10px;border:1px solid var(--line)}
.style-box h3,.script-box h3,.shot-fields h3{margin:0 0 8px;font-size:12px;color:var(--muted);font-weight:600;letter-spacing:.04em}
.style-box pre,.script-box pre,.shot-fields pre{margin:0;white-space:pre-wrap;word-break:break-word;font:inherit}
.toc{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px;margin:0 0 32px}
.toc a{display:flex;gap:8px;align-items:center;padding:8px 10px;border:1px solid var(--line);border-radius:8px;color:inherit;text-decoration:none;font-size:13px;overflow:hidden}
.toc a span{color:var(--accent);font-variant-numeric:tabular-nums;flex-shrink:0}
.toc a:hover{border-color:var(--accent);background:var(--panel)}
.shot{border:1px solid var(--line);border-radius:14px;padding:18px;margin:0 0 20px;background:#fff;break-inside:avoid}
.shot-head{display:flex;align-items:center;gap:12px;margin-bottom:14px}
.shot-index{font-variant-numeric:tabular-nums;color:var(--accent);font-weight:700;font-size:14px}
.shot-head h2{margin:0;font-size:18px;line-height:1.3}
.shot-media{background:#eceee7;border-radius:10px;overflow:hidden;border:1px solid var(--line);min-height:160px;display:grid;place-items:center}
.shot-media img{display:block;width:100%;max-height:520px;object-fit:contain;background:#111}
.missing,.empty-copy{color:var(--muted);padding:28px;font-size:13px}
.shot-fields{display:grid;gap:12px;margin-top:14px}
.shot-fields section{padding:12px 14px;background:var(--panel);border-radius:10px;border:1px solid var(--line)}
footer{margin-top:28px;padding-top:16px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}
@media print{body{background:#fff}.toc{display:none}.shot{box-shadow:none;page-break-inside:avoid}}
</style>
</head>
<body>
<div class="wrap">
<header class="cover">
  <p class="eyebrow">CUTPOT · STORYBOARD REVIEW</p>
  <h1>${esc(meta.name)}</h1>
  <p class="meta">分镜流确认稿 · 共 ${shots.length} 镜 · 导出于 ${esc(meta.exportedAt)}${meta.withImage ? ` · 含图 ${meta.withImage} 张` : ''}</p>
  ${meta.style ? `<div class="style-box"><h3>统一画面风格</h3><pre>${esc(meta.style)}</pre></div>` : ''}
  ${meta.script ? `<div class="script-box"><h3>完整脚本</h3><pre>${esc(meta.script)}</pre></div>` : ''}
</header>
<nav class="toc" aria-label="分镜目录">${toc}</nav>
${shotBlocks}
<footer>由 CutPot 导出 · 打开本文件即可离线查看与分享确认 · 图片已内嵌</footer>
</div>
</body>
</html>`;
}
async function exportStoryboardFlow() {
  snapshotDraft();
  await saveAllDrafts();
  const shots = S.shots.map(shot => {
    const draft = drafts.get(shot.id);
    return draft ? { ...shot, ...draft } : shot;
  });
  if (!shots.length) throw new Error('还没有分镜，无法导出分镜流');
  console.info('[storyboard-export] start', { projectId: S.projectId, shotCount: shots.length });
  notify(`正在导出分镜流（${shots.length} 镜）…`);
  const images = [];
  let withImage = 0;
  for (let i = 0; i < shots.length; i++) {
    const v = version(shots[i]);
    if (!v?.assetId) { images.push(''); continue; }
    images.push(await imageDataUrl(v.assetId));
    withImage++;
    if ((i + 1) % 4 === 0 || i === shots.length - 1) notify(`正在打包分镜图 ${i + 1}/${shots.length}…`);
  }
  const scriptDraft = drafts.get('script');
  const meta = {
    name: S.name || '未命名项目',
    exportedAt: new Date().toLocaleString('zh-CN'),
    style: scriptDraft?.style ?? S.style,
    script: scriptDraft?.script ?? S.script,
    withImage
  };
  const html = buildStoryboardHtml(shots, images, meta);
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeFileName(meta.name)}-分镜流.html`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  console.info('[storyboard-export] done', { file: a.download, withImage, bytes: blob.size });
  notify(`已导出分镜流：${shots.length} 镜 · 含图 ${withImage} 张`);
}
let exportPoll = null;
function stopExportPoll() { clearInterval(exportPoll); exportPoll = null; }
function exportJobView(job) {
  const file = `${safeFileName(S.name)}-首尾帧拼接.mp4`;
  const title = job.status === 'completed' ? '拼接视频已就绪' : job.status === 'failed' ? '拼接导出失败' : job.status === 'cancelled' ? '已取消导出' : '正在拼接首尾帧视频';
  modal(`<h2>${title}</h2><p>${esc(job.name || '')}</p><div class="progress"><span style="width:${Math.max(0, Math.min(100, job.progress || 0))}%"></span></div><p class="job-brief">${esc(job.message || '')}</p>${job.status === 'completed' ? `<p class="hint">按片段顺序硬切拼接，未叠配音与字幕。文件保存在本机 .cutpot/exports。</p>` : ''}<div class="dialog-actions">${job.status === 'running' ? `<button data-cancel-export="${job.id}">取消</button>` : ''}${job.status === 'completed' ? `<button class="primary" data-download-export="${job.id}" data-download-name="${esc(file)}">下载 MP4</button>` : ''}${closeButton}</div>`);
}
function monitorExport(id) {
  stopExportPoll();
  const tick = async () => {
    try {
      const jobs = await api('/api/jobs');
      const job = jobs.find(j => j.id === id);
      if (!job) { stopExportPoll(); return; }
      if (job.status === 'running') {
        if ($('#modal').open) exportJobView(job);
        return;
      }
      stopExportPoll();
      exportJobView(job);
      console.info('[segment-export] finished', { id, status: job.status, message: job.message });
      if (job.status === 'completed') notify('首尾帧拼接视频已就绪，可下载');
      else if (job.status === 'failed') notify(`拼接导出失败：${job.message}`);
    } catch (e) {
      stopExportPoll();
      console.warn('[segment-export] poll failed', e.message);
      notify(`导出状态读取失败：${e.message}`);
    }
  };
  exportPoll = setInterval(tick, 1000);
  tick();
}
async function exportSegmentConcat() {
  snapshotDraft();
  await saveItem(false);
  if (!S.segments.length) throw new Error('还没有视频片段，无法导出');
  const missing = S.segments.filter(s => !version(s));
  if (missing.length) throw new Error(`还有 ${missing.length} 个片段未生成或导入视频`);
  const stale = S.segments.filter(s => s.stale);
  if (stale.length) throw new Error(`${stale.length} 个片段的首尾帧或参数已变更，请先更新视频`);
  const fps = 25;
  const portrait = S.settings.ratio === '9:16';
  const width = portrait ? 1080 : 1920, height = portrait ? 1920 : 1080;
  const clips = S.segments.map((seg, i) => {
    const v = version(seg), a = asset(v.assetId);
    if (!a || a.type !== 'video') throw new Error(`片段 ${num(i + 1)} 的视频素材无效`);
    const duration = Math.floor(Math.min(seg.duration, a.duration) * fps) / fps;
    if (duration < 1 / fps) throw new Error(`片段 ${num(i + 1)} 时长不足一帧`);
    return { id: crypto.randomUUID(), title: `片段 ${num(i + 1)}`, assetId: a.id, duration, sourceIn: 0, subtitle: '', muted: true, locked: false };
  });
  const project = {
    version: 1, id: S.projectId, name: `${S.name || '未命名项目'}-首尾帧拼接`, fps, width, height,
    clips, narration: null, music: null, musicVolume: 0.12, burnSubtitles: false, updatedAt: new Date().toISOString()
  };
  console.info('[segment-export] start', { projectId: S.projectId, segments: clips.length, width, height });
  notify(`正在提交拼接导出（${clips.length} 段）…`);
  const job = await api('/api/render', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(project) });
  exportJobView(job);
  monitorExport(job.id);
}
async function runAction(fn) {
  if (busy) return;
  busy = true; document.body.classList.add('busy-overlay');
  try { await fn(); }
  catch (e) { error = e.message; notify(e.message); try { await refresh(false); } catch {} if ($('#modal').open) { const p = document.createElement('p'); p.className = 'inline-error'; p.setAttribute('role', 'alert'); p.textContent = e.message; $('#modal').append(p); } else render(); }
  finally { busy = false; document.body.classList.remove('busy-overlay'); }
}
async function action(name) {
  if(name==='new-project')return createNewProject({
    flush:saveAllDrafts,notify,currentName:S.name,
    onCreated:async()=>{drafts.clear();selected=null;selectedIds.clear();error='';stopExportPoll();await refresh();if(location.pathname!=='/storyboard')location.href='/storyboard';}
  });
  if(name==='download-project')return saveProjectFile({flush:saveAllDrafts,notify});
  if(name==='open-project')return $('#project-file').click();
  if (name === 'close-modal') return $('#modal').close();
  if (name === 'settings') return settings();
  if (name === 'refresh') { error = ''; return refresh(); }
  if (name === 'go-storyboard') { location.href = '/storyboard'; return; }
  if (name === 'go-videos') { await saveItem(); snapshotDraft(); const d = drafts.get('script'); if (d) { await commit({ action: 'script', ...d }, false); drafts.delete('script'); } location.href = '/videos'; return; }
  if (name === 'upload-reference') return openUpload('reference');
  if (name === 'reference-library') return library('reference', 'image');
  if (name === 'export-shots') return exportStoryboardFlow();
  if (name === 'export-segments') return exportSegmentConcat();
  if (name === 'upload-shots') return openUpload('shots');
  if (name === 'upload-current') { $('#modal').close(); return openUpload(uploadTarget, uploadTarget === 'reference' ? 'image' : kind, uploadTarget === 'reference'); }
  if (name === 'save-script') { snapshotDraft(); await commit({ action: 'script', ...drafts.get('script') }); drafts.delete('script'); notify('脚本与画面风格已保存'); }
  if (name === 'split') {
    snapshotDraft(); const script = $('#script').value, count = Number($('#shot-count').value), d = drafts.get('script');
    const split = async () => { if (d) await commit({ action: 'script', ...d }, false); await commit({ action: 'split', script, count, replace: true }); drafts.delete('script'); selected = S.shots[0]?.id; render(); notify(`已拆分 ${S.shots.length} 个分镜，原文已保留`); };
    if (S.shots.length) return askConfirm('重新拆分脚本', '现有分镜与视频片段将保存到分镜历史。新分镜需要重新选用图片，已有剪辑工程会保留。', '保存历史并拆分', split);
    await split();
  }
  if (name === 'demo') { await commit({ action: 'demo' }); selected = S.shots[0]?.id; drafts.clear(); render(); notify('示例分镜已载入，可继续生成首尾帧视频'); }
  if (name === 'add-shot') { await commit({ action: 'add-shot' }); selected = S.shots.at(-1).id; render(); }
  if (name === 'reset-filter') { filter = 'all'; query = ''; render(); }
  if (name === 'select-visible') { visibleItems().forEach(s => selectedIds.add(s.id)); render(); }
  if (name === 'clear-selection') { selectedIds.clear(); render(); }
  if (name === 'generate-batch') {
    snapshotDraft(); const ids = selectedIds.size ? [...selectedIds] : items().filter(x => (!version(x) || x.stale) && !generationBlocked(x)).map(x => x.id);
    await generateItems(ids);
  }
  if (name === 'stop-queue') { await commit({ action: 'stop-queue' }); notify('未提交的排队任务已停止；运行中的任务继续完成。'); }
  if (name === 'play-sequence') startSequence();
  if (name === 'stop-sequence') stopSequence();
  if (name === 'handoff') {
    snapshotDraft(); await saveItem(false);
    const mockCount = S.segments.filter(s => version(s)?.mode === 'mock').length, pending = S.segments.filter(s => version(s)?.review !== 'approved').length;
    return askConfirm('送入 CutPot 剪辑', `${S.segments.length} 段视频将按顺序添加到剪辑时间线。已关联的片段会更新版本，其他镜头与字幕会保留。${mockCount ? `其中 ${mockCount} 段为模拟素材。` : ''}${pending ? `${pending} 段尚未标记检查通过。` : ''}`, '送入并打开剪辑', async () => { await commit({ action: 'handoff', editorRevision: S.editorRevision }, false); location.href = '/editor'; });
  }
  if (name === 'rename') modal(`<h2>重命名项目</h2><form id="rename-form"><label for="rename-input">项目名称</label><input id="rename-input" name="name" maxlength="120" required value="${esc(S.name)}"><div class="dialog-actions">${closeButton}<button class="primary">保存名称</button></div></form>`);
  if (name === 'archives') modal(`<h2>分镜历史</h2><p>重新拆分和调整顺序前会保存历史，图片与视频版本一并保留。</p>${S.archives.length ? [...S.archives].reverse().map(a => `<div class="job-row row spread"><div>${new Date(a.createdAt).toLocaleString('zh-CN')}<p>${a.shots.length} 张分镜 · ${a.segments.length} 个片段</p></div><button class="small" data-restore="${a.id}">恢复此版本</button></div>`).join('') : '<p>暂时没有历史版本。</p>'}<div class="dialog-actions">${closeButton}</div>`);
  if (name === 'jobs') modal(`<h2>生成任务记录</h2><p>任务编号、输入快照与产物保存在本机。继续查询只跟踪已有任务。</p>${[...S.jobs].reverse().map(j => `<div class="job-row"><div class="row spread"><strong>${j.kind === 'image' ? '分镜图' : '首尾帧视频'} · ${j.mode === 'mock' ? '模拟' : '真实'}${j.kind === 'video' && j.provider ? ` · ${j.provider === 'dreamina' ? '即梦' : 'AutoDL'}` : ''}</strong>${badge(j.status)}</div><p>${esc(j.message)}</p><code>${esc(j.externalId || j.id)}</code><p>${new Date(j.createdAt).toLocaleString('zh-CN')}</p>${j.status === 'interrupted' && j.externalId ? `<button class="small" data-resume="${j.id}">继续查询已有任务</button>` : ''}</div>`).join('') || '<p>还没有生成任务。</p>'}<div class="dialog-actions">${closeButton}</div>`);
}
document.addEventListener('click', e => {
  if (providerMenuOpen && !e.target.closest('.provider-stat')) {
    providerMenuOpen = false;
    const card = document.querySelector('.provider-stat');
    if (card) { card.classList.remove('open'); card.querySelector('[data-provider-menu]')?.setAttribute('aria-expanded', 'false'); }
  }
  const el = e.target.closest('button,[data-select]'); if (!el || el.disabled) return;
  if (e.target.matches('[data-check]')) return;
  if (el.dataset.action) { e.preventDefault(); return runAction(() => action(el.dataset.action)); }
  if (el.dataset.check) return;
  if (el.dataset.edit) { select(el.dataset.edit); $('#item-prompt')?.focus(); return; }
  if (el.dataset.generate) return runAction(async () => { snapshotDraft(); if (el.dataset.generate === selected) await saveItem(false); await generateItems([el.dataset.generate]); });
  if (el.dataset.import) { select(el.dataset.import); return library(el.dataset.import); }
  if (el.dataset.asset) return runAction(async () => { await attach(el.dataset.asset); $('#modal').close(); });
  if (el.dataset.removeReference) return runAction(() => commit({ action: 'references', assetIds: S.references.filter(id => id !== el.dataset.removeReference) }));
  if (el.dataset.version) return runAction(async () => { snapshotDraft(); await commit({ action: 'select-version', kind, id: selected, versionId: el.dataset.version }); });
  if (el.dataset.review) return runAction(() => commit({ action: 'review', id: selected, review: el.dataset.review }));
  if (el.dataset.move) return runAction(() => commit({ action: 'move-shot', id: selected, direction: el.dataset.move }));
  if (el.dataset.resume) return runAction(async () => { await commit({ action: 'resume', id: el.dataset.resume }); $('#modal').close(); notify('已继续查询，不会重新提交生成'); });
  if (el.dataset.restore) return askConfirm('恢复历史分镜', '当前分镜也将存入历史，可随时恢复。现有剪辑工程会保留。', '恢复', async () => { drafts.clear(); await commit({ action: 'restore', id: el.dataset.restore }); });
  if (el.dataset.providerMenu === 'toggle') {
    e.preventDefault();
    providerMenuOpen = !providerMenuOpen;
    render();
    return;
  }
  if (el.dataset.videoProvider) return runAction(async () => {
    const next = el.dataset.videoProvider;
    providerMenuOpen = false;
    if (videoProvider() === next) { render(); return; }
    await commit({ action: 'settings', settings: { ...S.settings, videoProvider: next } });
    notify(`已切换到${providerLabel(next)}`);
  });
  if (el.dataset.cancelExport) return runAction(async () => { await api(`/api/jobs/${el.dataset.cancelExport}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); notify('已请求取消拼接导出'); });
  if (el.dataset.downloadExport) {
    const a = document.createElement('a');
    a.href = `/api/exports/${el.dataset.downloadExport}/film.mp4`;
    a.download = el.dataset.downloadName || `${safeFileName(S.name)}-首尾帧拼接.mp4`;
    document.body.append(a); a.click(); a.remove();
    return;
  }
  if (el.dataset.frame) { const seg = S.segments.find(s => s.fromShotId === el.dataset.frame) || S.segments.find(s => s.toShotId === el.dataset.frame); if (seg) select(seg.id); return; }
  if (el.dataset.segment) return select(el.dataset.segment);
  if (el.dataset.playSegment) return startSequence(el.dataset.playSegment);
  if (el.dataset.select) select(el.dataset.select);
});
document.addEventListener('input', e => {
  if (e.target.closest('#item-form') || ['script', 'style'].includes(e.target.id)) snapshotDraft();
  if (e.target.id === 'search') { query = e.target.value; $('#item-list').innerHTML = listCards(); }
});
document.addEventListener('change', e => {
  if (e.target.dataset.check) { e.target.checked ? selectedIds.add(e.target.dataset.check) : selectedIds.delete(e.target.dataset.check); snapshotDraft(); render(); }
  if (e.target.id === 'filter') { filter = e.target.value; snapshotDraft(); render(); }
});
document.addEventListener('submit', e => {
  e.preventDefault();
  runAction(async () => {
    if (e.target.id === 'item-form') { await saveItem(true); notify('当前项已保存'); }
    if (e.target.id === 'settings-form') {
      snapshotDraft();
      const raw = Object.fromEntries(new FormData(e.target));
      await commit({ action: 'settings', settings: { ...S.settings, ...raw, candidates: Number(raw.candidates) } });
      $('#modal').close(); notify('生成设置已保存');
    }
    if (e.target.id === 'rename-form') { const state = await api('/api/state'); if (state.projectRevision !== S.editorRevision) throw new Error('工程已更新，请刷新后重命名'); await api('/api/project', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': S.editorRevision }, body: JSON.stringify({ ...state.project, name: e.target.elements.name.value }) }); $('#modal').close(); await refresh(); }
  });
});
$('#upload').addEventListener('change', e => runAction(async () => {
  const files = [...e.target.files]; e.target.value = ''; if (!files.length) return;
  snapshotDraft();
  for (const file of files) {
    if (file.size > 1024 ** 3) throw new Error('单文件不能超过 1 GB');
    const a = await api(`/api/assets/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
    await refresh(false);
    if (uploadTarget === 'shots') {
      await commit({ action: 'add-shot' }, false); const shot = S.shots.at(-1);
      await commit({ action: 'shot', id: shot.id, title: file.name.replace(/\.[^.]+$/, ''), description: '', prompt: file.name.replace(/\.[^.]+$/, ''), negativePrompt: '' }, false);
      await commit({ action: 'attach', kind: 'image', id: shot.id, assetId: a.id }, false); selected = shot.id;
    } else await attach(a.id);
  }
  render(); notify(`${files.length} 个文件已导入`);
}));
$('#project-file').addEventListener('change',e=>runAction(async()=>{
  const file=e.target.files[0];e.target.value='';
  await importProjectFile(file,{
    revisions:async()=>{await saveAllDrafts();return {editorRevision:S.editorRevision,creationRevision:S.revision};},
    onImported:async()=>{drafts.clear();selected=null;selectedIds.clear();error='';await refresh();notify('工程已导入，三个页面已同步恢复');}
  });
}));
document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.dataset.select && !e.target.matches('input,textarea')) select(e.target.dataset.select); });
window.addEventListener('beforeunload', e => { if (drafts.size) { e.preventDefault(); e.returnValue = ''; } });
function signature(s) { return JSON.stringify([s.projectId, s.revision, s.name, s.editorRevision, s.jobs.map(j => [j.id, j.status, j.progress, j.message])]); }
async function poll() {
  try {
    if (S && !busy) {
      const next = await api('/api/pipeline'), changed = signature(next) !== lastSignature;
      // Keep the revision of the form the user actually saw. Advancing it behind a
      // draft would turn a stale form into an apparently current write.
      const protectedView = drafts.size || sequencePlaying || $('#modal').open || document.activeElement?.matches('input,textarea,select') || [...document.querySelectorAll('video')].some(v=>!v.paused);
      if(changed && !protectedView){
        S=next;
        if(!items().some(x=>x.id===selected))selected=items()[0]?.id||null;
        selectedIds=new Set([...selectedIds].filter(id=>items().some(x=>x.id===id)));
        render();
      }
    }
  } catch (e) { if (S?.jobs.some(j => ['running', 'queued'].includes(j.status))) notify(`任务状态读取失败：${e.message}`); }
  setTimeout(poll, S?.jobs.some(j => ['running', 'queued'].includes(j.status)) ? 2500 : 8000);
}
try { await refresh(); poll(); }
catch (e) { $('#app').innerHTML = `<div class="boot"><h1>工作区加载失败</h1><p>${esc(e.message)}</p><p>确认本机服务已启动，然后重新加载。</p><button onclick="location.reload()">重新加载</button></div>`; }
