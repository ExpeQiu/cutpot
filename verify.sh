#!/bin/sh
set -eu
cd "$(dirname "$0")"
if [ -z "${CUTPOT_SUBTITLE_PYTHON:-}" ] && [ -x .cutpot/subtitle-runtime/bin/python ]; then
  export CUTPOT_SUBTITLE_PYTHON="$PWD/.cutpot/subtitle-runtime/bin/python"
fi
npm run check
npm test
