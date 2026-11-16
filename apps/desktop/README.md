# Oraculum Desktop 2.0 — P4.1

An independent Ubuntu Electron client foundation. The application loads its own
React bundle, even with no Gateway configured. P4.1 includes the approved three
themes, connection entry, explicitly labelled local appearance preview, local
appearance preferences and native recovery. It does **not** connect or pair with
Gateway, send messages, read projects or implement persistent conversation data.

Source of truth: [P4.1 Task](https://app.notion.com/p/41a5421e690b81e0b07ff1000d8c8abc)
and the [accepted P4.0 design](../../upgrade/phase4/README.md). The phase remains
subject to user review. See the P4.1 delivery record in `upgrade/phase4/p41/` for
the actual validation results and limitations.

## Build and run

From the repository root, using Node 24 and the pinned pnpm version:

```bash
pnpm install --frozen-lockfile
pnpm build:desktop
pnpm --filter @oraculum/desktop start
```

`pnpm desktop` builds and starts the same client. On a Wayland session, an explicit
native Wayland launch is also available:

```bash
pnpm --filter @oraculum/desktop exec electron ./dist --ozone-platform=wayland
```

On Ubuntu hosts that restrict unprivileged user namespaces, an unpacked Electron
download may require an already installed, trusted SUID sandbox helper. Chromium
supports selecting that helper for a **development process** through
`CHROME_DEVEL_SANDBOX`. The helper must be root-owned, correctly permissioned and
API-compatible. See [Chromium's development sandbox notes](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/linux/suid_sandbox_development.md).
The P4.1 validation record gives the exact verified host invocation. This client
does not install a helper, change system security settings or disable its sandbox.

The bundle is `apps/desktop/dist/`: main, sandboxed preload, renderer, resource
manifest, native icon, package identity and build provenance. It is a runnable
development bundle, **not** a DEB, installer or Release. No local web server or
backend process is required. The new executable identity is `oraculum-desktop`;
it does not install or take over the Gateway's `oraculum` CLI.

Do not use the historical `build:desktop:deb` or `test:phase3:*` workflows for this
client. They belong to the legacy application and are not P4.1 validation paths.
The top-level `.cjs` files and splash assets are retained only as historical
source; the new package entry and build do not import them.

## Local state and recovery

The application uses its own `oraculum-desktop-v2` namespace under the XDG config
directory (or `~/.config`). Development and packaged production profiles are
separate. An optional `ORACULUM_DESKTOP_PROFILE` **slug**, such as `visual-review`,
selects a separate profile within that mode; it is not a filesystem path.

Only the selected theme and Inspector visibility are application state in this
phase. Chromium's own cache/session files also stay inside the selected profile.
There is no migration or scan of old Oraculum, Gateway, Android or Codex data.
The local sample does not save drafts, fabricate credentials or initiate writes.

Use the native application menu or **Ctrl+Shift+0** to restore the built-in
appearance. This resets the new appearance and zoom, without touching unrelated
state. A damaged preference file falls back visibly to the defaults; its bytes
are preserved on recovery. Unsafe profile paths/permissions and damaged bundles
fail closed with a local error, rather than loading a Gateway page.

Closing the last window exits the client. There is no tray or background service.
Opening the same profile a second time focuses its existing instance.

## Process and resource boundaries

- `src/main/` owns the private profile, small validated preference file, window
  lifecycle, native recovery and local resource serving.
- `src/preload/` exposes only the typed capabilities in
  [desktop.ts](src/contracts/desktop.ts); it does not expose Electron, an IPC
  channel selector, file paths, credentials, shell execution or network clients.
- `src/renderer/` owns React and the new Tailwind/token visual system. It does
  not import `apps/web`, Bridge or the old theme system.
- `scripts/build.mjs` bundles local resources with pinned existing dependencies
  and records SHA-256/size for each renderer asset. The runtime validates and
  serves the fixed resource set from `oraculum-app://bundle/index.html`.

The renderer keeps sandbox, context isolation and web security enabled; Node
integration, webviews, popups, navigation, downloads, permissions and outbound
network access are disabled. CSP permits packaged script/style/image/font
resources, without inline script, `eval`, remote resources or frames. IPC validates
the registered live window, main frame, entry URL and bounded preference DTOs.
These are the application boundaries; the GUI tests verify their actual behavior.

The resource integrity manifest detects damaged or substituted bundle files.
It is not a code-signing system against an attacker who can rewrite the entire
application and manifest. Such packaging/distribution guarantees belong to the
later release phase.

## Checks

```bash
pnpm check:desktop
pnpm test:desktop
pnpm build:desktop
```

`pnpm test:desktop:gui` runs the built application in the real Wayland session;
apply any required development sandbox environment from the P4.1 delivery record.
The command uses a temporary isolated profile and stores output under
`.local/desktop-p41/gui` (or an explicit `--output=` directory). The screenshots
and precise evidence boundaries are documented in the P4.1 delivery record.
It runs with Chromium sandbox enabled;
static/unit fixtures and native compositor evidence are identified separately.

P4.2 will implement bounded Gateway authentication/transport/IPC and real actions.
Zustand and IndexedDB remain the approved later business-state/cache direction;
P4.1 does not create empty business stores or databases merely to mirror that plan.
