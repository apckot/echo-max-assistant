#!/bin/sh
set -eu
# Never source configuration, enable shell tracing, or put credentials in argv.
exec python3 "$(dirname "$0")/deploy.py" "$@"
