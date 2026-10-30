#!/bin/bash
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")"
trap 'status=$?; if [ "$status" -ne 0 ]; then echo "启动失败，请先运行安装入口并查看上方错误。"; read -r -p "按回车关闭…" answer; fi' EXIT
node scripts/desktop.mjs start
