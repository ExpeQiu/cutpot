#!/bin/sh
set -eu
cd "$(dirname "$0")"
exec node bin/cutpot-cli.js stop "$@"
