import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('local API persists projects, rejects foreign origins and validates byte ranges',async()=>{
  const data=await mkdtemp(path.join(os.tmpdir(),'cutpot-api-'));
  const port=String(18000+Math.floor(Math.random()*20000)),base=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['src/server.js'],{env:{...process.env,PORT:port,CUTPOT_DATA:data},stdio:['ignore','pipe','pipe']});
  try{
    await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',code=>reject(new Error(`Server exited ${code}`)));});
    const initial=await (await fetch(`${base}/api/state`)).json();assert.equal(initial.project.clips.length,0);
    assert.equal((await fetch(`${base}/api/project`,{method:'PUT',headers:{Origin:'https://foreign.invalid'},body:'{}'})).status,403);
    const project={...initial.project,name:'保存验证'};
    const saved=await fetch(`${base}/api/project`,{method:'PUT',body:JSON.stringify(project)});assert.equal(saved.status,200);
    assert.equal((await (await fetch(`${base}/api/state`)).json()).project.name,'保存验证');
    const invalid=await fetch(`${base}/api/render`,{method:'POST',body:JSON.stringify(project)});assert.equal(invalid.status,400);
    const range=await fetch(base,{headers:{Range:'bytes=0-14'}});assert.equal(range.status,206);assert.equal((await range.arrayBuffer()).byteLength,15);
    assert.equal((await fetch(base,{headers:{Range:'bytes=999999-'}})).status,416);
    assert.equal((await fetch(`${base}/api/assets/upload?name=bad.txt`,{method:'POST',body:'not media'})).status,400);
  }finally{if(child.exitCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await exited;}await rm(data,{recursive:true,force:true});}
});
