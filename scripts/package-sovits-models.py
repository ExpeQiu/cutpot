"""Verify model companion files and create a portable ZIP with an archive checksum."""
import hashlib
import json
from pathlib import Path
import zipfile

root=Path(__file__).resolve().parent.parent/'releases'/'GPT-SoVITS-models-20261030'
manifest=json.loads((root/'model-manifest.json').read_text())
def digest(p):
    h=hashlib.sha256()
    with p.open('rb') as f:
        for b in iter(lambda:f.read(8*1024*1024),b''):h.update(b)
    return h.hexdigest()
for entry in manifest['files']:
    p=root/entry['path']
    if p.stat().st_size!=entry['size'] or digest(p)!=entry['sha256']:raise SystemExit('Invalid model: '+entry['path'])
if list(root.rglob('*.partial')):raise SystemExit('Incomplete downloads remain')
for name in ['G2PWModel.zip','nltk_data.zip','GPT-SoVITS-source.zip']:
    with zipfile.ZipFile(root/name) as z:
        if z.testzip() is not None:raise SystemExit('Damaged archive: '+name)
with zipfile.ZipFile(root/'G2PWModel.zip') as z:
    if not any(n.endswith('.onnx') for n in z.namelist()):raise SystemExit('G2PW ONNX model missing')
    print('G2PW archive:',z.namelist()[:8],flush=True)
files=[p for p in sorted(root.rglob('*')) if p.is_file() and p.name!='package-manifest.json']
release={'model':manifest['model'],'date':'2026-10-30','sourceCommit':manifest['sourceCommit'],'inferenceTested':False,'officialModelHashesVerified':True,'files':[{'path':p.relative_to(root).as_posix(),'size':p.stat().st_size,'sha256':digest(p)} for p in files]}
(root/'package-manifest.json').write_text(json.dumps(release,ensure_ascii=False,indent=2))
archive=root.parent/'GPT-SoVITS-v2ProPlus-模型包-20261030.zip'
if archive.exists():raise SystemExit('Archive already exists: '+str(archive))
with zipfile.ZipFile(archive,'x',compression=zipfile.ZIP_STORED,allowZip64=True) as z:
    for p in sorted(root.rglob('*')):
        if p.is_file():z.write(p,Path(root.name)/p.relative_to(root))
checksum=digest(archive)
archive.with_suffix('.zip.sha256').write_text(f'{checksum}  {archive.name}\n')
print(json.dumps({'archive':str(archive),'size':archive.stat().st_size,'sha256':checksum,'modelFiles':len(manifest['files'])},ensure_ascii=False),flush=True)
