#!/usr/bin/env bash
# Keep automated windows and notifications off the user's active desktop.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ $# -eq 0 ]]; then
  printf 'Usage: bash scripts/isolated-ui.sh <test command> [arguments...]\n' >&2
  exit 2
fi
xvfb_bin="${ORACULUM_XVFB_BIN:-$PWD/.local/test-display/root/usr/bin/Xvfb}"
if [[ ! -x "$xvfb_bin" ]]; then
  xvfb_bin="$(command -v Xvfb || true)"
fi
if [[ -z "$xvfb_bin" || ! -x "$(dirname "$xvfb_bin")/xvfb-run" ]]; then
  printf 'Xvfb and xvfb-run are required. Install or extract them locally; no desktop fallback.\n' >&2
  exit 2
fi
export PATH="$(dirname "$xvfb_bin"):$PATH"
# Only this disposable scope is limited; no production unit/settings are changed.
# Xvfb uses a private Xauthority cookie, no TCP listener and software rendering.
# The private D-Bus session prevents test notifications reaching the real desktop.
exec systemd-run --user --scope --quiet \
  -p MemoryHigh=4G -p MemoryMax=6G -p MemorySwapMax=512M -p CPUQuota=200% \
  nice -n 10 dbus-run-session --config-file scripts/fixtures/dbus-isolated.conf -- \
  env -u WAYLAND_DISPLAY -u WAYLAND_SOCKET -u SESSION_MANAGER \
    XDG_SESSION_TYPE=x11 XDG_CURRENT_DESKTOP=Xvfb GTK_USE_PORTAL=0 GDK_BACKEND=x11 ELECTRON_OZONE_PLATFORM_HINT=x11 \
    LIBGL_ALWAYS_SOFTWARE=1 \
  xvfb-run -a -s '-screen 0 1920x1200x24 -nolisten tcp' "$@"
