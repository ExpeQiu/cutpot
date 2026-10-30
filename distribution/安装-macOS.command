#!/bin/bash
set -euo pipefail
export PATH="/opt/homebrew/bin:/opt/homebrew/opt/node/bin:/usr/local/bin:/usr/local/opt/node/bin:$PATH"
cd "$(dirname "$0")"
trap 'status=$?; if [ "$status" -ne 0 ]; then echo "安装未完成，请查看上方错误。"; fi; read -r -p "按回车关闭…" answer' EXIT
if ! command -v node >/dev/null || ! node -e 'process.exit(Number(process.versions.node.split(".")[0])>=22?0:1)'; then
  if ! command -v brew >/dev/null; then echo '请先安装 Node.js 22+：https://nodejs.org/en/download 或 Homebrew：https://brew.sh，然后重新安装。'; exit 1; fi
  brew install node
fi
if ! command -v ffmpeg >/dev/null || ! command -v ffprobe >/dev/null; then
  if ! command -v brew >/dev/null; then echo '请先安装 Homebrew（https://brew.sh），再运行 brew install ffmpeg，然后重新安装。'; exit 1; fi
  brew install ffmpeg
fi
python_bin="$(command -v python3 || true)"
if [ -z "$python_bin" ] || ! "$python_bin" -c 'import sys; sys.exit(0 if (3,10)<=sys.version_info[:2]<(3,15) else 1)'; then
  if ! command -v brew >/dev/null; then echo '请先安装 Python 3.10–3.14：https://www.python.org/downloads/'; exit 1; fi
  brew install python@3.12
  python_bin="$(brew --prefix python@3.12)/bin/python3.12"
fi
"$python_bin" -m venv .cutpot/subtitle-runtime
.cutpot/subtitle-runtime/bin/python -m pip install -r requirements-subtitles.txt
node scripts/desktop.mjs check
mkdir -p "$HOME/.local/bin"
if [ ! -e "$HOME/.local/bin/cutpot-cli" ] && [ ! -L "$HOME/.local/bin/cutpot-cli" ]; then
  ln -s "$PWD/cutpot-cli" "$HOME/.local/bin/cutpot-cli"
else
  echo "已有 ~/.local/bin/cutpot-cli，予以保留。可使用本安装文件夹内的 ./cutpot-cli。"
fi
echo '安装完成！双击「启动-macOS.command」。CLI：本文件夹内 ./cutpot-cli，或将 ~/.local/bin 加入 PATH 后使用 cutpot-cli。'
