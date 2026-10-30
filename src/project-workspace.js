import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, mkdir, readFile, writeFile, rename, constants as fsConstants } from 'node:fs/promises';
import path from 'node:path';

export function appDataRoot(workspace, env = process.env) {
  return path.resolve(env.CUTPOT_DATA || path.join(workspace, '.cutpot'));
}

export function projectDataRoot(projectDir) {
  return path.join(path.resolve(projectDir), '.cutpot');
}

export async function readWorkspace(appRoot) {
  try {
    const data = JSON.parse(await readFile(path.join(appRoot, 'workspace.json'), 'utf8'));
    if (data?.version !== 1) return { version: 1, projectDir: null };
    return { version: 1, projectDir: data.projectDir ? path.resolve(data.projectDir) : null };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { version: 1, projectDir: null };
  }
}

export async function writeWorkspace(appRoot, config) {
  await mkdir(appRoot, { recursive: true });
  const next = { version: 1, projectDir: config.projectDir ? path.resolve(config.projectDir) : null };
  const file = path.join(appRoot, 'workspace.json');
  await writeFile(`${file}.tmp`, JSON.stringify(next, null, 2));
  await rename(`${file}.tmp`, file);
  return next;
}

export async function resolveDataRoot(appRoot) {
  const workspace = await readWorkspace(appRoot);
  if (!workspace.projectDir) return { root: appRoot, projectDir: null, workspace };
  return { root: projectDataRoot(workspace.projectDir), projectDir: workspace.projectDir, workspace };
}

export async function ensureProjectDirs(root) {
  for (const name of ['media', 'thumbs', 'tmp', 'generation', 'exports']) {
    await mkdir(path.join(root, name), { recursive: true });
  }
}

export async function validateProjectDir(input) {
  const raw=String(input||'').trim();
  if(!raw)throw new Error('请选择项目文件夹');
  const projectDir=path.resolve(raw);
  if(projectDir===path.parse(projectDir).root)throw new Error('请选择有效的项目文件夹');
  if(!existsSync(projectDir))throw new Error(`项目文件夹不存在：${projectDir}`);
  try{await access(projectDir,fsConstants.R_OK|fsConstants.W_OK);}
  catch{throw new Error(`项目文件夹不可读写：${projectDir}`);}
  return projectDir;
}

function runCapture(binary, args, timeout = 180000) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('选择文件夹超时')); }, timeout);
    child.stdout.on('data', b => { out += b; });
    child.stderr.on('data', b => { err += b; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error((err || out || `${binary} 退出 ${code}`).trim() || '已取消选择文件夹'));
    });
  });
}

/** Native folder picker for the local workbench. */
export async function pickProjectFolder() {
  if (process.platform === 'darwin') {
    const script = 'try\nPOSIX path of (choose folder with prompt "选择 CutPot 项目文件夹（创作记录将保存在此）")\non error number -128\nerror "已取消选择文件夹" number 1\nend try';
    const out = await runCapture('osascript', ['-e', script]);
    return validateProjectDir(out.trim().replace(/\/$/, ''));
  }
  if (process.platform === 'win32') {
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms;',
      '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog;',
      '$dialog.Description = "选择 CutPot 项目文件夹（创作记录将保存在此）";',
      '$dialog.ShowNewFolderButton = $true;',
      'if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { throw "已取消选择文件夹" };',
      '[Console]::Out.Write($dialog.SelectedPath)'
    ].join(' ');
    const out = await runCapture('powershell.exe', ['-NoProfile', '-Command', ps]);
    return validateProjectDir(out.trim());
  }
  try {
    const out = await runCapture('zenity', ['--file-selection', '--directory', '--title=选择 CutPot 项目文件夹']);
    return validateProjectDir(out.trim());
  } catch {
    throw new Error('当前系统无法弹出文件夹选择器，请在输入框填写项目文件夹绝对路径');
  }
}
