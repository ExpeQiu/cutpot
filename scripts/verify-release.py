"""Verify the file set and hashes in a CutPot software release."""
import hashlib
import json
from pathlib import Path
import sys

root=Path(sys.argv[1] if len(sys.argv)>1 else '.').resolve()
manifest=json.loads((root/'release-manifest.json').read_text(encoding='utf-8'))
for item in manifest['files']:
    file=(root/item['path']).resolve()
    if not file.is_relative_to(root) or not file.is_file() or file.is_symlink():
        raise SystemExit(f"Invalid/missing release file: {item['path']}")
    if hashlib.sha256(file.read_bytes()).hexdigest()!=item['sha256']:
        raise SystemExit(f"Checksum mismatch: {item['path']}")
print(f"Verified {len(manifest['files'])} release files, CutPot {manifest['version']}")
