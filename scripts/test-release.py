"""Smoke-test an extracted software package without touching the live workspace."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.request

root=Path(sys.argv[1]).resolve()
def command(*args,env=None):
    return subprocess.run(args,cwd=root,env=env,check=True,capture_output=True,text=True).stdout
command(sys.executable,'scripts/verify-release.py',str(root))
command('node','scripts/desktop.mjs','check')
assert json.loads(command('node','bin/cutpot-cli.js','--version','--json'))['version']=='0.8.1'
if os.name!='nt':assert '0.8.1' in command('bash','./cutpot-cli','--version')
with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
base=f'http://127.0.0.1:{port}'
env={**os.environ,'CUTPOT_URL':base,'CUTPOT_NO_BROWSER':'1'}
def api(route,data=None):
    req=urllib.request.Request(base+route,data=json.dumps(data).encode() if data is not None else None,headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=30) as res:return json.load(res)
try:
    command('node','scripts/desktop.mjs','start',env=env)
    state=api('/api/state');assert not state['project']['clips'];assert not state['assets']
    demo=api('/api/demo',{})
    assert len(demo['project']['clips'])==19
    p=demo['project'];p['clips']=p['clips'][:1];p['clips'][0]['duration']=.4;p['clips'][0]['subtitle']='跨电脑安装验证：中文字幕';p['burnSubtitles']=True
    job=api('/api/render',p)
    for _ in range(300):
        current=next(j for j in api('/api/jobs') if j['id']==job['id'])
        if current['status']!='running':break
        time.sleep(.2)
    assert current['status']=='completed',current
    output=root/'.cutpot'/'exports'/job['id']/'film.mp4'
    data=json.loads(command('ffprobe','-v','error','-count_frames','-show_streams','-show_format','-of','json',str(output)))
    video=next(s for s in data['streams'] if s['codec_type']=='video')
    assert video['width']==1920 and int(video['nb_read_frames'])==10
    assert abs(float(data['format']['duration'])-.4)<.005
    command('ffmpeg','-v','error','-i',str(output),'-f','null','-')
    print(json.dumps({'status':'passed','relocatedPackage':str(root),'demoClips':19,'burnSubtitles':True,'exportFrames':10,'duration':.4},ensure_ascii=False))
finally:
    try:command('node','bin/cutpot-cli.js','stop','--json',env=env)
    except Exception as error:print(f'Service cleanup: {error}',file=sys.stderr)
