import { readFile, writeFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { probe, run } from './render.js';

export function validateSovitsSettings(input) {
  let url;
  try{url=new URL(input?.endpoint||'http://127.0.0.1:9880');}catch{throw new Error('请输入有效的 GPT-SoVITS 本机地址');}
  if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error('GPT-SoVITS 仅支持本机 HTTP 地址，例如 http://127.0.0.1:9880');
  if(typeof input?.referenceAudio!=='string'||!path.isAbsolute(input.referenceAudio)||input.referenceAudio.includes('\0'))throw new Error('请选择参考音频或填写本机绝对路径');
  if(typeof input?.promptText!=='string'||!input.promptText.trim()||input.promptText.length>2000)throw new Error('请填写参考音频实际说出的文字（最多 2000 字符）');
  if(!['child','adult'].includes(input.ageGroup))throw new Error('请明确参考录音为儿童还是成人声音');
  return {endpoint:url.origin,referenceAudio:input.referenceAudio,promptText:input.promptText.trim(),ageGroup:input.ageGroup,referenceName:path.basename(String(input.referenceName||input.referenceAudio)).slice(0,120)};
}
export function sovitsCharacters(env=process.env){
  if(!env.CUTPOT_SOVITS_SETTINGS)throw new Error('GPT-SoVITS 未配置：请先启动本机推理服务并添加参考音频');
  const data=JSON.parse(env.CUTPOT_SOVITS_SETTINGS);
  const characters=data.characters??[{...data,id:'reference',name:'默认角色'}];
  if(!Array.isArray(characters)||!characters.length||characters.length>100)throw new Error('角色配置无效');
  const ids=new Set();
  return characters.map(c=>{if(typeof c.id!=='string'||!/^[-a-zA-Z0-9_]{1,60}$/.test(c.id)||ids.has(c.id))throw new Error('角色 ID 无效或重复');ids.add(c.id);return {...validateSovitsSettings(c),id:c.id,name:String(c.name||c.id).slice(0,60)};});
}
export function sovitsConfig(env=process.env,voice){
  const characters=sovitsCharacters(env);
  const selected=voice?characters.find(c=>c.id===voice):characters[0];
  if(!selected)throw new Error(`角色音色不存在：${voice}，请先配置角色参考录音`);
  return selected;
}
export function sovitsSettingsStatus(env=process.env){
  try{return {configured:true,...sovitsConfig(env),characters:sovitsCharacters(env)};}catch{return {configured:false,endpoint:'http://127.0.0.1:9880',referenceAudio:null,referenceName:null,promptText:'',ageGroup:'child',characters:[]};}
}
export async function loadSovitsSettings(root,env=process.env){
  if(env.CUTPOT_SOVITS_SETTINGS){sovitsConfig(env);return sovitsSettingsStatus(env);}
  let input;
  try{input=JSON.parse(await readFile(path.join(root,'gpt-sovits.json'),'utf8'));}
  catch(e){if(e.code==='ENOENT')return sovitsSettingsStatus(env);throw new Error('GPT-SoVITS 本机配置无法读取，请重新配置');}
  const candidate={CUTPOT_SOVITS_SETTINGS:JSON.stringify(input)};sovitsCharacters(candidate);env.CUTPOT_SOVITS_SETTINGS=candidate.CUTPOT_SOVITS_SETTINGS;return sovitsSettingsStatus(env);
}
const settingsQueues=new WeakMap();
export async function saveSovitsSettings(root,input,env=process.env){
  const previous=settingsQueues.get(env)??Promise.resolve();
  const next=previous.catch(()=>{}).then(()=>saveCharacterSettings(root,input,env));
  settingsQueues.set(env,next);return next;
}
async function saveCharacterSettings(root,input,env){
  const settings=validateSovitsSettings(input);
  const id=input.characterId??'reference',name=String(input.characterName||id).trim();
  if(typeof id!=='string'||!/^[-a-zA-Z0-9_]{1,60}$/.test(id)||!name||name.length>60)throw new Error('角色 ID 使用 1–60 位字母数字、下划线或短横线；角色名称最多 60 字');
  let characters=[];if(env.CUTPOT_SOVITS_SETTINGS)characters=sovitsCharacters(env);
  if(!characters.some(c=>c.id===id)&&characters.length>=100)throw new Error('最多保存 100 个角色');
  const source=await stat(settings.referenceAudio);if(!source.isFile())throw new Error('参考音频必须是本机文件');
  const media=await probe(settings.referenceAudio);
  if(media.type!=='audio'||!Number.isFinite(media.duration)||media.duration<3||media.duration>10)throw new Error('参考音频需要 3—10 秒的纯音频，请先裁剪后导入');
  await mkdir(path.join(root,'tts-references'),{recursive:true});
  const reference=path.join(root,'tts-references',`${randomUUID()}.wav`);
  const destination=path.join(root,'gpt-sovits.json'),temp=`${destination}.${randomUUID()}.tmp`;
  let saved=false;
  try{
    await run('ffmpeg',['-hide_banner','-loglevel','error','-y','-i',settings.referenceAudio,'-vn','-ar','32000','-ac','1','-c:a','pcm_s16le',reference]);
    settings.referenceAudio=reference;
    const character={...settings,id,name};
    const index=characters.findIndex(c=>c.id===id);if(index<0)characters.push(character);else characters[index]=character;
    await writeFile(temp,JSON.stringify({...settings,characters}),{mode:0o600,flag:'wx'});await rename(temp,destination);saved=true;
  }finally{await rm(temp,{force:true});if(!saved)await rm(reference,{force:true});}
  env.CUTPOT_SOVITS_SETTINGS=JSON.stringify({...settings,characters});return sovitsSettingsStatus(env);
}
