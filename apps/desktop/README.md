# Oraculum Desktop 2.0 — P4.2

An independent Ubuntu Electron client with its own React bundle, three approved
themes, isolated profiles and native recovery. P4.2 adds Gateway pairing,
main-owned HTTP/WS communication, projects and native conversations, bounded
interactions, attachments and file access. Persistent drafts and history caching
remain P4.3 work.

Source of truth: [P4.2 Task](https://app.notion.com/p/41a5421e690b81668bbbd49e17e7d400)
and the [accepted P4.0 design](../../upgrade/phase4/README.md). P4.1 is accepted;
P4.2 remains **In progress**, subject to user review. See the
[P4.2 architecture and review guide](../../upgrade/phase4/p42/README.md) for
current ownership, recovery, approval boundaries, evidence and limitations.

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
client. They belong to the legacy application and are not current validation paths.
The top-level `.cjs` files and splash assets are retained only as historical
source; the new package entry and build do not import them.

## Local state and recovery

The application uses its own `oraculum-desktop-v2` namespace under the XDG config
directory (or `~/.config`). Development and packaged production profiles are
separate. An optional `ORACULUM_DESKTOP_PROFILE` **slug**, such as `visual-review`,
selects a separate profile within that mode; it is not a filesystem path.

Appearance, encrypted device identities and the durable operation journal stay
inside the selected profile, alongside Chromium's cache/session files. Credentials
require Electron safeStorage with `gnome_libsecret`; unavailable or weak storage
fails closed. Access tokens stay in main memory. There is no migration or scan of
old Oraculum, Gateway, Android or Codex data.

Conversation projections and scoped drafts are in memory. The journal persists
before dispatch, and restores unresolved operations by querying their original
operationId. An unknown result or query 404 never triggers automatic write replay.
Journal recovery does not restore draft text or cached conversation history.
After launch, enter the Endpoint again to reuse its saved device identity.
Persistent drafts/history remain P4.3 work. Event-only Plan, Diff and thread token
usage may be absent after reconnect because snapshots do not include all of them.

Use the native application menu or **Ctrl+Shift+0** to restore the built-in
appearance. This resets appearance and zoom without clearing credentials or the
operation journal. A damaged preference file falls back visibly to the defaults; its bytes
are preserved on recovery. Unsafe profile paths/permissions and damaged bundles
fail closed with a local error, rather than loading a Gateway page.

Closing the last window exits the client. There is no tray or background service.
Opening the same profile a second time focuses its existing instance.

## Process and resource boundaries

- `src/main/` owns the private profile, preferences, credentials, Gateway
  transport, operation journal, authoritative client projection, bounded file
  access, window lifecycle, native recovery and local resource serving.
- `src/preload/` exposes only the typed capabilities in
  [desktop.ts](src/contracts/desktop.ts) and [workspace.ts](src/contracts/workspace.ts);
  it does not expose Electron, an IPC
  channel selector, file paths, credentials, shell execution or network clients.
- `src/renderer/` owns React and the new Tailwind/token visual system. It does
  not import `apps/web`, Bridge or the old theme system. Zustand holds the UI
  projection and scoped drafts in memory; main validates all business intents.
- `scripts/build.mjs` bundles local resources with pinned existing dependencies
  and records SHA-256/size for each renderer asset. The runtime validates and
  serves the fixed resource set from `oraculum-app://bundle/index.html`.

The renderer keeps sandbox, context isolation and web security enabled; Node
integration, webviews, popups, navigation, downloads, permissions and outbound
network access are disabled. CSP permits packaged resources and data images for
bounded file previews, without inline script, `eval`, remote resources or frames.
IPC validates the registered live window, main frame, entry URL and bounded DTOs.
Remote Gateway endpoints require HTTPS/WSS; HTTP/WS is allowed only on exact
loopback. Origin and Base Path remain configurable deployment inputs.

Pending interactions must match current scope, epoch and generation. File-change
acceptance additionally requires a current, complete bounded patch proof and the
digest displayed by the renderer. Stale state, summaries, previews and truncated
or ambiguous patches cannot authorize acceptance. Native file dialogs select
uploads and save verified downloads; native sharing is not implemented.

The resource integrity manifest detects damaged or substituted bundle files.
It is not a code-signing system against an attacker who can rewrite the entire
application and manifest. Such packaging/distribution guarantees belong to the
later release phase.

## Checks

```bash
pnpm check:desktop
pnpm exec vitest run apps/desktop/src/main apps/desktop/src/renderer
pnpm build:desktop
```

`pnpm test:desktop` covers main-process tests only. The command above also covers
renderer tests. `scripts/desktop-p42-fixtures.ts` runs the built Electron app with
an isolated profile, fixture business data and no Gateway connection; see the
P4.2 guide for the verified host sandbox invocation and artifact location.
Fixture results and real Gateway/native desktop evidence must remain separate.

`pnpm test:desktop:gui` is the historical P4.1 foundation script. Real P4.2 testing
uses the authorized existing Gateway and a dedicated client profile; it does not
create a test Gateway or authorize service changes. No formal DEB or Release is
produced in this phase.

The verified source is `7d34e16b54ecc1280656d15b06c8ff87bfc66245`, pushed with
matching local and remote `main`. `pnpm check`, 814/814 tests and the Desktop build
passed. The actual Electron fixture passed 16/16 checks with zero TCP attempts;
real native desktop and local HTTP/WS evidence are recorded separately in the
[P4.2 review guide](../../upgrade/phase4/p42/README.md#验证记录).
Real pending approvals were not triggered, and the native session lacked a Plan
tool; those displays have fixture coverage. The task remains **In progress** for
user review.
