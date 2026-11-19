# Oraculum Desktop 2.0

An independent Ubuntu Electron client with its own React bundle, three approved
themes, isolated profiles and native recovery. P4.2 adds Gateway pairing,
main-owned HTTP/WS communication, projects and native conversations, bounded
interactions, attachments and file access. P4.3 adds IndexedDB history, offline
reading, durable per-conversation drafts, reading-position restoration and bounded
long-conversation rendering, while preserving the main-process execution boundary.

Source of truth: [Oraculum 2.0 canon](https://app.notion.com/p/4135421e690b815eb404c3024c860134)
and the [accepted P4.0 design](../../upgrade/phase4/README.md). P4.0–P4.3 are
accepted, with P4.3 at `1b19e0a`. The current
[P4.3.5 cleanup](../../upgrade/phase4/p435/README.md) remains **In progress** for
user review. See the
[P4.3 architecture and review guide](../../upgrade/phase4/p43/README.md) for data
ownership, cross-store recovery, validation status and limitations. The
[P4.2 guide](../../upgrade/phase4/p42/README.md) preserves the accepted communication
and security baseline.

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

P4.3.5 removes the retired top-level `.cjs` runtime, splash assets and old
Desktop 0.2.0 packaging chain, along with its dedicated test/release workflows.
`build:desktop:deb` and `verify:desktop:deb` fail explicitly pending P4.4; they do
not build or verify an old package. The new package entry is
`dist/main/index.cjs`. Desktop DEB packaging requires separate P4.4 work.

## Local state and recovery

The application uses its own `oraculum-desktop-v2` namespace under the XDG config
directory (or `~/.config`). Development and packaged production profiles are
separate. An optional `ORACULUM_DESKTOP_PROFILE` **slug**, such as `visual-review`,
selects a separate profile within that mode; it is not a filesystem path.

Appearance, the non-secret connection preference, encrypted device identities and
the durable operation journal stay inside the selected profile, alongside
Chromium's session and IndexedDB files. Credentials
require Electron safeStorage with `gnome_libsecret`; unavailable or weak storage
fails closed. Access tokens stay in main memory. There is no migration or scan of
old Oraculum, Gateway, Android or Codex data.

The saved Endpoint includes its normalized Origin and Base Path. Startup restores
its local identity namespace from encrypted metadata, then connects through the
existing authentication flow when automatic connection is enabled. Manual
disconnect keeps offline reading available; logout and known revocation hide the
identity's local display without deleting its drafts or journal.

IndexedDB `oraculum-desktop-v2-local` separates drafts, history, history LRU,
navigation, reading positions and layout preferences into object stores. Data is
scoped by Endpoint, installation, device, project and conversation; profile layout
preferences are device-local. Cached content is explicitly last-known/read-only
and never restores permissions, pending approvals or write authority. Only
previously loaded content is available offline. Plan, Diff and thread token usage
may be shown as last-known data because snapshots do not provide full replay reads.

Draft edits use revision-based compare-and-swap transactions. Sending first commits
a pending draft revision in IndexedDB, then main persists its original operationId
and draft association before dispatch. Prepared/unknown results are queried by
that same operationId, never replayed. Main rejects a second dispatch of the same
draft revision even after an accepted receipt. A missing operation can release a
local pending draft only after main explicitly proves its absence in the readable
journal; a query 404 or failed IPC is not such proof. Accepted receipt handling
does not erase a newer edit or claim that the native Turn has completed.

The display cache has a profile-wide LRU budget of 32 entries / 64 MiB, with an
8 MiB single-entry limit. Long cached conversations retain a bounded item window;
trimming is visible and invalidates a cursor that could skip removed content.
These bounds describe cached payloads, not total Chromium disk or process memory.
The renderer keeps six hot histories, mounts at most 80 visible/nearby messages
plus a focused row, and expands long outputs in 16,000-character segments. Reading
anchors follow native item identity and do not pull the viewport to new output
while the user is reading earlier messages.

Use the native application menu or **Ctrl+Shift+0** to restore the built-in
appearance. This resets appearance, zoom and panel layout without reloading the
renderer or clearing drafts, credentials or the operation journal. The explicit
history-clear action removes only the current identity's display history and
reading positions. A damaged preference file falls back visibly to the defaults; its bytes
are preserved on recovery. Unsafe profile paths/permissions and damaged bundles
fail closed with a local error, rather than loading a Gateway page.

Closing the window waits for local save queues. Failed or timed-out saving opens a
native confirmation with cancel as the default. A forced process termination can
recover committed data, but not guarantee every edit from an unfinished
transaction. Corrupt drafts, newer database versions and conflicting revisions
are preserved rather than silently overwritten. Closing the last window exits the
client without canceling a remote Codex Turn. There is no tray or background
service. Opening the same profile a second time focuses its existing instance.

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
  projection and scoped drafts in memory; IndexedDB persists local data using
  bounded transactions. Main validates all business intents and owns the journal.
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

`pnpm test:desktop` covers both main-process and renderer tests. `scripts/desktop-p43-fixtures.ts` runs the built sandboxed Electron
app on GNOME/Wayland with an isolated profile, real Chromium IndexedDB and generated
business data. It covers storage faults, recovery, interaction and a synthetic
long-history workload without connecting to Gateway. See the P4.3 guide for the
verified host sandbox invocation, output location and final evidence status.
Run GUI acceptance only after building, without a concurrent build or another GUI
acceptance process. Fixtures and real Gateway/native desktop evidence stay separate.

`pnpm test:desktop:gui` selects the current P4.3 fixture harness. The superseded
P4.1 harness has been removed. Real Gateway acceptance uses the authorized existing
Gateway and the dedicated `p42-review` client profile; it does not create a test
Gateway or authorize service changes. No formal Desktop DEB or Release is produced
in P4.3.5.

P4.2 was accepted at `85b303c`. P4.3 implementation steps `df9962e`, `093a807`,
`02ef260`, `9b3b277` and the final visual fix `f2e7b67` have been committed and
pushed. Core validation at `9b3b277` passed `pnpm check`; the visual fix again
passed type checking, 923/923 Desktop unit tests across 23 files and
`pnpm build:desktop`. The final `f2e7b67` Electron harness rerun passed 31 P4.3 checks
and 16 P4.2 regression checks, with no Gateway traffic. Its recorded `sourceDirty=true`
reflects then-uncommitted harness/delivery material. Later visual fixes, final
clean-build comparison and final Git publication metadata are recorded separately
in [validation.json](../../upgrade/phase4/p43/validation.json); evidence keeps each
tested bundle's source and manifest rather than claiming identical renderer bytes.

Real local HTTP/WS acceptance retained the dedicated identity and original 24
operations, added three authorized test operations, and verified a native Codex
reply, accepted draft-version association and preservation of newer edits.
Online/offline new-process restarts restored Endpoint, identity, conversation,
drafts and reading state without replaying writes. Native GNOME/Wayland checks
included Alt+F4, actual Rime composition, keyboard focus, narrow windows and the
three themes. Gateway's six recorded service/startup properties remained unchanged;
the client exited and the original input engine was restored. Detailed results,
screenshots and performance sampling caveats are in the
[P4.3 review guide](../../upgrade/phase4/p43/README.md#提交与验证记录).

For the final single-run 1,000-message sample, initial display took 340 ms versus 750 ms
in P4.2, with 5 versus 1,000 mounted rows. Worst sampled scroll frame improved,
while p95 did not: 23.6 ms versus 17 ms. Initial JS heap also did not decrease;
counters were sampled without forced GC and are not steady-state RSS measurements.
Real pending approvals and Plan
execution remain fixture-only; real lock/wake was not separately tested. Forced
termination recovery covers committed data, not an unfinished last edit.
HTTPS/WSS configuration does not imply real remote/TLS acceptance. P4.4, DEB
installation and Release publication remain outside P4.3.5. P4.3 is accepted;
the cleanup task stays **In progress** for review.
