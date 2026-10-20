#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
ORACULUM_TOOLS="${ORACULUM_TOOLS:-$HOME/.local/share/oraculum-tools}"
export JAVA_HOME="$ORACULUM_TOOLS/jdk-21"
export ANDROID_HOME="$ORACULUM_TOOLS/android-sdk"
export GRADLE_USER_HOME="$ORACULUM_TOOLS/gradle-cache"
"$ORACULUM_TOOLS/gradle-8.13/bin/gradle" -p apps/android --no-daemon --console=plain :app:assembleDebug :app:lintDebug "$@"
