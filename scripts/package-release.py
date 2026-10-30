"""Build a clean cross-platform software archive; never copy local runtime data."""
import hashlib
import json
from pathlib import Path
import shutil
import sys
import tempfile
import zipfile

root=Path(__file__).resolve().parent.parent
version=json.loads((root/'package.json').read_text())['version']
output=Path(sys.argv[1] if len(sys.argv)>1 else root/'releases').resolve()
output.mkdir(parents=True,exist_ok=True)
name=f'CutPot-{version}-macOS-Windows-20261026'
archive=output/f'{name}.zip'
if archive.exists():
    raise SystemExit(f'Release already exists: {archive}')
with tempfile.TemporaryDirectory(prefix='cutpot-package-') as work:
    stage=Path(work)/name
    stage.mkdir()
    for folder in ['src','public','bin','test']:
        shutil.copytree(root/folder,stage/folder,ignore=shutil.ignore_patterns('__pycache__','*.pyc','.DS_Store'))
    for file in ['package.json','README.md','requirements-subtitles.txt','requirements-tts.txt']:
        shutil.copy2(root/file,stage/file)
    (stage/'docs').mkdir()
    for file in ['cutpot-cli.md','tts.md','自动剪辑软件产品规划.md','时间轴剪辑.md','工程保存与导入.md']:
        shutil.copy2(root/'docs'/file,stage/'docs'/file)
    (stage/'scripts').mkdir()
    for file in ['desktop.mjs','render-subtitles.py','verify-release.py']:
        shutil.copy2(root/'scripts'/file,stage/'scripts'/file)
    for file in (root/'distribution').iterdir():
        target=stage/('scripts/windows.ps1' if file.name=='windows.ps1' else file.name)
        shutil.copy2(file,target)
    # The demo uses a stable relative folder, independent of the original workstation.
    source=root/'storyboard'/'乐乐安全教育'/'全片分镜_01-23'
    target=stage/'demo'/'lele'
    target.mkdir(parents=True)
    for i in range(1,24):
        shutil.copy2(source/f'分镜{i:02d}.png',target/f'分镜{i:02d}.png')
    # Windows PowerShell 5.1 needs UTF-8 BOM for non-ASCII scripts; CRLF for cmd files.
    for file in stage.rglob('*.ps1'):
        text=file.read_text(encoding='utf-8-sig');file.write_text(text,encoding='utf-8-sig')
    files=[]
    for file in sorted(stage.rglob('*')):
        if file.is_file():files.append({'path':file.relative_to(stage).as_posix(),'bytes':file.stat().st_size,'sha256':hashlib.sha256(file.read_bytes()).hexdigest()})
    (stage/'release-manifest.json').write_text(json.dumps({'app':'CutPot','version':version,'date':'2026-10-26','platforms':['macOS-arm64','macOS-x64','Windows-x64'],'includesPrivateData':False,'files':files},ensure_ascii=False,indent=2),encoding='utf-8')
    with zipfile.ZipFile(archive,'x',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
        for file in sorted(stage.rglob('*')):
            if file.is_file():z.write(file,Path(name)/file.relative_to(stage))
checksum=hashlib.sha256(archive.read_bytes()).hexdigest()
(archive.with_suffix('.zip.sha256')).write_text(f'{checksum}  {archive.name}\n',encoding='utf-8')
shutil.copy2(root/'distribution'/'安装说明.md',output/f'{name}-安装说明.md')
print(json.dumps({'archive':str(archive),'bytes':archive.stat().st_size,'sha256':checksum},ensure_ascii=False))
