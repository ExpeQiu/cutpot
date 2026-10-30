import { randomUUID } from 'node:crypto';
import { readFile, access, constants } from 'node:fs/promises';
import path from 'node:path';
import { defaultProject, validateProject } from './project.js';
import { timeline, timelineDuration } from '../public/timeline.js';
import { probe } from './render.js';

export const MANIFEST_SCHEMA_VERSION = 1;

/** Versioned field definition for Agent / scripts. Matches runtime validation. */
export function manifestSchema() {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    kind: 'cutpot.render.manifest',
    description: '本地文件路径镜头清单；路径相对清单文件解析。与 project save 的素材 ID 快照不同。',
    resolutions: ['1920x1080', '1280x720', '1080x1920'],
    fps: [24, 25, 30],
    limits: { clips: { min: 1, max: 2000 }, subtitleChars: 2000, nameChars: 120 },
    fields: {
      name: { type: 'string', optional: true, maxLength: 120 },
      resolution: { type: 'string', optional: true, enum: ['1920x1080', '1280x720', '1080x1920'], note: '也可写 width+height' },
      width: { type: 'integer', optional: true },
      height: { type: 'integer', optional: true },
      fps: { type: 'integer', optional: true, enum: [24, 25, 30], default: 25 },
      narration: { type: 'string', optional: true, note: '相对或绝对音频路径' },
      music: { type: 'string', optional: true, note: '相对或绝对音频路径' },
      musicVolume: { type: 'number', optional: true, min: 0, max: 1, default: 0.12 },
      clips: {
        type: 'array',
        required: true,
        items: {
          file: { type: 'string', required: true },
          title: { type: 'string', optional: true, maxLength: 200 },
          sourceIn: { type: 'number', optional: true, alias: 'in', min: 0, note: '源入点秒' },
          duration: { type: 'number', optional: true, note: '省略时视频取入点后完整帧，图片默认 3 秒；按 fps 量化' },
          subtitle: { type: 'string', optional: true, maxLength: 2000 },
          muted: { type: 'boolean', optional: true, default: true, note: 'false 保留源音' },
          locked: { type: 'boolean', optional: true, default: false },
        },
      },
    },
    example: {
      name: '教育短片',
      resolution: '1920x1080',
      fps: 25,
      narration: './voice.wav',
      music: './bgm.mp3',
      musicVolume: 0.12,
      clips: [
        { file: './shot_01.mp4', title: '开场', sourceIn: 0.5, duration: 3, subtitle: '大家好', muted: true },
        { file: './ending.png', duration: 5, subtitle: '你会怎么做？' },
      ],
    },
  };
}

export class ManifestIssue extends Error {
  constructor(message, { code = 'MANIFEST_INVALID', clip = null, field = null, retryable = false } = {}) {
    super(message);
    this.code = code;
    this.clip = clip;
    this.field = field;
    this.retryable = retryable;
  }
  toJSON() {
    return {
      error: this.message,
      code: this.code,
      ...(this.clip != null ? { clip: this.clip } : {}),
      ...(this.field ? { field: this.field } : {}),
      retryable: this.retryable,
    };
  }
}

function number(value, label, { min = 0, max = Infinity } = {}, meta = {}) {
  const n = Number(value);
  if (value === '' || !Number.isFinite(n) || n < min || n > max) {
    throw new ManifestIssue(`${label} 数值无效`, { code: 'MANIFEST_NUMBER', ...meta });
  }
  return n;
}

function applyOutputSettings(project, input) {
  if (input.fps !== undefined) project.fps = number(input.fps, '帧率', { min: 1 }, { field: 'fps' });
  if (input.resolution !== undefined) {
    const match = /^(\d+)x(\d+)$/.exec(String(input.resolution));
    if (!match) throw new ManifestIssue('分辨率应写为 1920x1080、1280x720 或 1080x1920', { code: 'MANIFEST_RESOLUTION', field: 'resolution' });
    project.width = Number(match[1]);
    project.height = Number(match[2]);
  }
  if (input.width !== undefined) project.width = number(input.width, '宽度', { min: 1 }, { field: 'width' });
  if (input.height !== undefined) project.height = number(input.height, '高度', { min: 1 }, { field: 'height' });
  if (input.name !== undefined) project.name = String(input.name).slice(0, 120);
  if (input.musicVolume !== undefined) project.musicVolume = number(input.musicVolume, '音乐音量', { max: 1 }, { field: 'musicVolume' });
  return project;
}

function clipOptions(raw, index) {
  const meta = { clip: index + 1 };
  if (typeof raw?.file !== 'string' || !raw.file.trim()) {
    throw new ManifestIssue(`镜头 ${index + 1} 必须提供 file 路径`, { code: 'MANIFEST_CLIP_FILE', field: 'file', ...meta });
  }
  return {
    file: raw.file,
    title: raw.title,
    in: raw.sourceIn ?? raw.in,
    duration: raw.duration,
    subtitle: raw.subtitle,
    muted: raw.muted,
    locked: raw.locked === true,
    keepAudio: raw.muted === false,
  };
}

function buildClip(asset, options, fps, index) {
  const meta = { clip: index + 1 };
  const sourceIn = number(options.in ?? 0, `镜头 ${index + 1} 入点`, { min: 0 }, { ...meta, field: 'sourceIn' });
  let duration;
  if (options.duration !== undefined) {
    duration = number(options.duration, `镜头 ${index + 1} 时长`, { min: 1 / fps }, { ...meta, field: 'duration' });
  } else if (asset.type === 'image') {
    duration = 3;
  } else {
    duration = Math.floor((asset.duration - sourceIn) * fps + 1e-6) / fps;
  }
  return {
    id: randomUUID(),
    assetId: asset.id,
    title: options.title ?? asset.name,
    duration,
    sourceIn,
    subtitle: options.subtitle ?? '',
    muted: !options.keepAudio,
    locked: options.locked === true,
  };
}

async function fileExists(file) {
  try {
    await access(file, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function loadMedia(file, expectedKinds, meta) {
  if (!(await fileExists(file))) {
    throw new ManifestIssue(`找不到文件：${file}`, { code: 'MANIFEST_FILE_MISSING', field: meta.field, clip: meta.clip, retryable: false });
  }
  let info;
  try {
    info = await probe(file);
  } catch (e) {
    throw new ManifestIssue(`无法读取媒体：${file}（${e.message}）`, {
      code: 'MANIFEST_PROBE_FAILED',
      field: meta.field,
      clip: meta.clip,
      retryable: true,
    });
  }
  if (!expectedKinds.includes(info.type)) {
    throw new ManifestIssue(`期望 ${expectedKinds.join('/')}，实际为 ${info.type}：${file}`, {
      code: 'MANIFEST_MEDIA_TYPE',
      field: meta.field,
      clip: meta.clip,
    });
  }
  return {
    id: randomUUID(),
    name: path.basename(file),
    path: file,
    type: info.type,
    duration: info.duration,
    width: info.width,
    height: info.height,
    hasAudio: info.hasAudio,
  };
}

/** Parse JSON only; no filesystem writes. */
export async function readManifest(file) {
  const absolute = path.resolve(file);
  let input;
  try {
    input = JSON.parse(await readFile(absolute, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') throw new ManifestIssue(`找不到清单：${absolute}`, { code: 'MANIFEST_NOT_FOUND', field: 'manifest' });
    throw new ManifestIssue(`清单 JSON 无效：${e.message}`, { code: 'MANIFEST_JSON', field: 'manifest' });
  }
  if (!input || !Array.isArray(input.clips) || input.clips.length === 0 || input.clips.length > 2000) {
    throw new ManifestIssue('清单 clips 必须包含 1—2000 个镜头', { code: 'MANIFEST_CLIPS', field: 'clips' });
  }
  return { absolute, dir: path.dirname(absolute), input };
}

/**
 * Probe local files and build a project snapshot without importing into the workbench.
 * Collects all issues when collect=true; otherwise throws on first ManifestIssue / validate error.
 */
export async function analyzeManifest(file, { collect = false } = {}) {
  const issues = [];
  const note = (issue) => {
    if (collect) issues.push(issue.toJSON ? issue.toJSON() : { error: issue.message, code: issue.code || 'ERROR', retryable: Boolean(issue.retryable) });
    else throw issue;
  };

  let absolute, dir, input;
  try {
    ({ absolute, dir, input } = await readManifest(file));
  } catch (e) {
    if (e instanceof ManifestIssue) {
      note(e);
      return { ok: false, absolute: path.resolve(file), issues, project: null, assets: [], plan: null };
    }
    throw e;
  }

  const project = applyOutputSettings(defaultProject(), { ...input, name: input.name ?? '清单合成' });
  const assets = [];
  const clipFiles = [];

  for (let i = 0; i < input.clips.length; i++) {
    try {
      const options = clipOptions(input.clips[i], i);
      const mediaPath = path.resolve(dir, options.file);
      const asset = await loadMedia(mediaPath, ['video', 'image'], { clip: i + 1, field: 'file' });
      assets.push(asset);
      project.clips.push(buildClip(asset, options, project.fps, i));
      clipFiles.push({ index: i + 1, file: mediaPath, type: asset.type });
    } catch (e) {
      if (e instanceof ManifestIssue) note(e);
      else note(new ManifestIssue(e.message, { code: 'MANIFEST_CLIP', clip: i + 1 }));
    }
  }

  for (const key of ['narration', 'music']) {
    if (!input[key]) continue;
    try {
      const mediaPath = path.resolve(dir, input[key]);
      const asset = await loadMedia(mediaPath, ['audio'], { field: key });
      assets.push(asset);
      project[key] = asset.id;
    } catch (e) {
      if (e instanceof ManifestIssue) note(e);
      else note(new ManifestIssue(e.message, { code: 'MANIFEST_AUDIO', field: key }));
    }
  }

  let validated = null;
  if (!issues.length) {
    try {
      validated = validateProject(project, assets);
    } catch (e) {
      const clipMatch = /镜头 (\d+)/.exec(e.message);
      note(new ManifestIssue(e.message, {
        code: 'MANIFEST_PROJECT',
        clip: clipMatch ? Number(clipMatch[1]) : null,
        field: /旁白|音乐|音轨/.test(e.message) ? 'audio' : /字幕/.test(e.message) ? 'subtitle' : 'clips',
      }));
    }
  }

  if (issues.length || !validated) {
    console.error('[manifest] validate failed', JSON.stringify({ file: absolute, issues: issues.length }));
    return { ok: false, absolute, issues, project: null, assets, plan: null, clipFiles };
  }

  const items = timeline(validated);
  const duration = timelineDuration(validated);
  const narrationAsset = validated.narration ? assets.find(a => a.id === validated.narration) : null;
  const musicAsset = validated.music ? assets.find(a => a.id === validated.music) : null;
  const blockers = [];
  if (narrationAsset && narrationAsset.duration > duration + 0.05) {
    blockers.push({
      code: 'NARRATION_LONGER_THAN_FILM',
      message: `旁白约 ${narrationAsset.duration.toFixed(2)}s，成片约 ${duration.toFixed(2)}s；导出时会截断旁白`,
      field: 'narration',
      retryable: false,
      severity: 'warning',
    });
  }
  for (const item of items) {
    if (item.clip.subtitle && item.clip.subtitle.length > 80) {
      blockers.push({
        code: 'SUBTITLE_LONG',
        message: `镜头 ${item.index + 1} 字幕较长（${item.clip.subtitle.length} 字），可能影响可读性`,
        clip: item.index + 1,
        field: 'subtitle',
        severity: 'warning',
        retryable: false,
      });
    }
  }

  const plan = {
    name: validated.name,
    fps: validated.fps,
    width: validated.width,
    height: validated.height,
    duration,
    frames: Math.round(duration * validated.fps),
    clipCount: validated.clips.length,
    clips: items.map((item, i) => ({
      index: i + 1,
      file: clipFiles[i]?.file,
      type: clipFiles[i]?.type,
      title: item.clip.title,
      sourceIn: item.clip.sourceIn,
      duration: item.clip.duration,
      startFrame: item.startFrame,
      endFrame: item.endFrame,
      start: item.start,
      end: item.end,
      muted: item.clip.muted,
      subtitle: item.clip.subtitle,
      transition: item.transition,
    })),
    narration: narrationAsset ? { file: narrationAsset.path, duration: narrationAsset.duration } : null,
    music: musicAsset ? { file: musicAsset.path, duration: musicAsset.duration } : null,
    musicVolume: validated.musicVolume,
    blockers,
  };

  console.error('[manifest] validate ok', JSON.stringify({ file: absolute, clips: plan.clipCount, duration: plan.duration, warnings: blockers.length }));
  return { ok: true, absolute, issues: [], project: validated, assets, plan, clipFiles };
}

export async function validateManifestFile(file) {
  const result = await analyzeManifest(file, { collect: true });
  return {
    ok: result.ok,
    manifest: result.absolute,
    issues: result.issues,
    ...(result.plan ? { summary: { name: result.plan.name, duration: result.plan.duration, frames: result.plan.frames, clips: result.plan.clipCount } } : {}),
  };
}

export async function dryRunManifest(file, { output = null } = {}) {
  const result = await analyzeManifest(file, { collect: true });
  if (!result.ok) {
    return { ok: false, dryRun: true, manifest: result.absolute, issues: result.issues, plan: null };
  }
  return {
    ok: true,
    dryRun: true,
    manifest: result.absolute,
    output: output ? path.resolve(output) : null,
    imported: false,
    rendered: false,
    ...result.plan,
  };
}
