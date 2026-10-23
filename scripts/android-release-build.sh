#!/usr/bin/env bash
# Gradle must never receive a signing password, including transient environment input.
set +x
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
unset ORACULUM_RELEASE_UNSIGNED ORACULUM_RELEASE_KEYSTORE ORACULUM_RELEASE_KEY_ALIAS ORACULUM_RELEASE_STORE_PASSWORD ORACULUM_RELEASE_KEY_PASSWORD ORACULUM_RELEASE_CERT_SHA256
if [[ $# -ne 1 || "$1" != --unsigned ]]; then
  printf 'Use --unsigned for build preflight. For a signed Release, run locally: python3 scripts/android-signing.py release\n' >&2
  exit 2
fi
artifact=apps/android/app/build/outputs/apk/release/app-release-unsigned.apk
printf 'Unsigned Release preflight only; this APK is not a signed release or an installation deliverable.\n'

ORACULUM_TOOLS="${ORACULUM_TOOLS:-$HOME/.local/share/oraculum-tools}"
export JAVA_HOME="$ORACULUM_TOOLS/jdk-21"
export ANDROID_HOME="$ORACULUM_TOOLS/android-sdk"
export GRADLE_USER_HOME="$ORACULUM_TOOLS/gradle-cache"
export PATH="$JAVA_HOME/bin:$PATH"
# Fixed flags/tasks: no caller-provided Gradle flags, logging, cache or scans.
# Kotlin runs in the short-lived Gradle process; no signing secret enters this build.
rm -rf -- apps/android/app/build/outputs/apk/release
"$ORACULUM_TOOLS/gradle-8.13/bin/gradle" -p apps/android \
  --no-daemon --no-build-cache --no-configuration-cache --no-scan --console=plain \
  -Pkotlin.compiler.execution.strategy=in-process \
  :app:lintRelease :app:testReleaseUnitTest :app:assembleRelease
node scripts/verify-apk.mjs "$artifact" --unsigned
