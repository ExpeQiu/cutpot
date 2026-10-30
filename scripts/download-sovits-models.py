"""Download a verified GPT-SoVITS v2ProPlus inference model companion pack."""
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import time
from urllib.parse import quote

root=Path(__file__).resolve().parent.parent/'releases'/'GPT-SoVITS-models-20261030'
root.mkdir(parents=True,exist_ok=True)
tree=json.loads(Path('/tmp/modelscope-sovits-tree.json').read_text())
shutil.copy2('/tmp/modelscope-sovits-tree.json',root/'upstream-files.json')
items=[]
for item in tree['Data']['Files']:
    p=item['Path']
    include=(p.startswith(('pretrained_models/chinese-hubert-base/','pretrained_models/chinese-roberta-wwm-ext-large/','pretrained_models/sv/','pretrained_models/fast_langdetect/')) or p in ['pretrained_models/s1v3.ckpt','pretrained_models/v2Pro/s2Gv2ProPlus.pth','G2PWModel.zip','nltk_data.zip','open_jtalk_dic_utf_8-1.11.tar.gz'])
    if include and item['Type']=='blob':
        item={**item,'url':'https://modelscope.cn/models/XXXXRT/GPT-SoVITS-Pretrained/resolve/'+item['Revision']+'/'+quote(p,safe='/')}
        items.append(item)
(root/'download-plan.json').write_text(json.dumps(items,ensure_ascii=False,indent=2))
total=sum(i['Size'] for i in items)
def digest(file):
    h=hashlib.sha256()
    with file.open('rb') as f:
        for block in iter(lambda:f.read(4*1024*1024),b''):h.update(block)
    return h.hexdigest()
def download(item):
    file=root/item['Path'];file.parent.mkdir(parents=True,exist_ok=True)
    if file.exists() and file.stat().st_size==item['Size'] and digest(file)==item['Sha256']:return item['Path']
    if file.exists():raise RuntimeError('Existing file failed validation: '+item['Path'])
    part=Path(str(file)+'.partial')
    if not part.exists() or part.stat().st_size!=item['Size']:
        result=subprocess.run(['curl','--fail','--location','--silent','--show-error','--connect-timeout','15','--speed-limit','16384','--speed-time','90','--max-time','1800','--retry','3','--retry-delay','2','--continue-at','-','--output',str(part),item['url']],capture_output=True,text=True)
        if result.returncode:raise RuntimeError(item['Path']+': '+result.stderr[-1000:])
    if part.stat().st_size!=item['Size'] or digest(part)!=item['Sha256']:raise RuntimeError('Size/SHA256 mismatch: '+item['Path'])
    part.rename(file);return item['Path']
print(json.dumps({'event':'start','files':len(items),'bytes':total}),flush=True)
with ThreadPoolExecutor(max_workers=4) as pool:
    pending={pool.submit(download,i):i for i in items};last=0
    while pending:
        done,_=wait(pending,timeout=5,return_when=FIRST_COMPLETED)
        for f in done:
            item=pending.pop(f)
            print(json.dumps({'event':'verified','file':f.result(),'bytes':item['Size']}),flush=True)
        if time.monotonic()-last>10:
            size=sum((root/i['Path']).stat().st_size if (root/i['Path']).exists() else (Path(str(root/i['Path'])+'.partial').stat().st_size if Path(str(root/i['Path'])+'.partial').exists() else 0) for i in items)
            print(json.dumps({'event':'progress','downloadedBytes':size,'totalBytes':total,'percent':round(100*size/total,1)}),flush=True);last=time.monotonic()
manifest={'model':'GPT-SoVITS v2ProPlus','date':'2026-10-30','repository':'XXXXRT/GPT-SoVITS-Pretrained','upstream':'https://github.com/RVC-Boss/GPT-SoVITS','sourceCommit':'b4570b876f5c086819ba84e3215472733c6a7b70','files':[{'path':i['Path'],'size':i['Size'],'sha256':i['Sha256'],'revision':i['Revision'],'url':i['url']} for i in items]}
(root/'model-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
print(json.dumps({'event':'complete','verifiedFiles':len(items),'bytes':total}),flush=True)
