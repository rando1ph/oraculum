# P4.3.5 — Legacy code cleanup

Task: [Oraculum 2.0｜P4.3.5：遗留代码与旧打包链路清理](https://app.notion.com/p/41d5421e690b81b68ddfc1a1856b5750).
Accepted starting baseline: `1b19e0a5c4f24c9ec08c2d7fd94932235a501c0e`.
The cleanup task remains **In progress** for user review.

## Scope

Remove retired `bridge/`, `apps/web/`, `themes/` and the old top-level Electron
runtime/splash files in `apps/desktop/`, along with their exclusive test, runtime,
packaging and candidate-release tooling. Align package scripts, workspaces,
TypeScript inputs and the lockfile with the active Gateway, native Android and
independent Desktop products. No compatibility layer is required for the retired
architecture.

Retain modules by their current import graph, including Gateway Protocol, the
official App Server protocol generator and non-UI shared logic used by Gateway
or Desktop. Preserve `design/` brand originals, approved Phase 0–4 records,
published tags/Releases and user-owned untracked or ignored files. Legacy source
remains available through Git history.

Gateway, Android and the accepted Desktop business logic, protocol 2.1,
credentials, receipts, IPC and IndexedDB semantics are outside the change scope.
The existing Gateway Beta 3 service, private configuration and user data must
remain untouched. Verification uses host-side checks and existing fixtures;
it does not authorize a second Gateway or a repeat of the large GUI/live matrix.

## Build and packaging boundary

`pnpm build:desktop` builds the current independent bundle.
`pnpm build:gateway:runtime` builds the standalone Gateway; `pnpm build` builds
both. Gateway runtime/package builds preserve their clean-source and provenance
checks. The existing Gateway DEB chain and native Android build/signing tooling
remain independent.

The old Desktop 0.2.0 builder, Forge configuration, verifier and legacy component
candidate workflow are removed. `build:desktop:deb` and `verify:desktop:deb` fail
with a P4.4 pending message, so those familiar command names cannot produce or
accept the wrong package. There is no combined `build:deb` entrypoint.

P4.4 still needs to define packaging around the accepted Desktop bundle, its
`oraculum-desktop` identity, native resources and sandbox requirements, followed
by the separately authorized isolated installation and candidate checks. This
cleanup does not implement that system, build/install a formal Desktop DEB,
publish a Release or advance to P4.4.

## Dependency audit and deletion inventory

The cleanup deletes 269 tracked files. It removes no ignored/untracked data.

| Group | Deleted files | Dependency decision |
| --- | ---: | --- |
| `bridge/` | 65 | Retired backend; no active Gateway/Desktop/Android imports |
| `apps/web/` | 69 | Retired shared React UI; clients own their UI |
| `themes/` | 20 | Retired Theme API v1 CSS, manifests and exclusive assets |
| Old `apps/desktop/` runtime and splash | 8 | Current entry is `dist/main/index.cjs`, built from `src/` |
| `packages/shared/` legacy modules/tests | 13 | Only MCP elicitation validation has current product consumers |
| `scripts/` | 87 | Bridge/Web/old Desktop tests, lifecycle, packaging and release code; also superseded P4.1 GUI harness |
| Root `packaging/` legacy files | 6 | Old Forge, runtime config, launch/service and desktop templates |
| `.github/` candidate workflow | 1 | Only built the retired Bridge/Desktop 0.2.0 components |

`packages/shared/elicitation.ts` and its test remain: Gateway interactions,
Desktop workspace actions and renderer forms all consume this same validation.
`packages/gateway-protocol/`, the pinned official App Server protocol generator,
current Android/Gateway fixtures, P4.2/P4.3 Desktop fixtures, Gateway packaging
and all required license notices remain. Desktop now declares `ws`, Gateway
Protocol and shared validation directly; Gateway declares shared validation.
Only manifest declarations changed in those product dependency graphs.

The workspace lists the four current JS/TS packages explicitly (plus the root).
Root type/test inputs exclude retired paths; `test:desktop` includes renderer
and main-process tests, and `test:desktop:gui` selects the current P4.3 harness.
Forge dependencies, old workspace importers and Android-irrelevant legacy
component versions were removed from manifests/lock/release metadata. The
Desktop bundle's development marker now matches its accepted P4.3 stage.

A root README and documentation index identify current commands. Twenty-five
historical documents carry archive notices while retaining their original
content; approved Phase 0–4 evidence and brand sources are preserved. No
replacement release workflow or Desktop DEB system was introduced.

## Verification

Host checks use Node 24.21.0 / pnpm 10.34.7. `pnpm install --frozen-lockfile`
passes; 169 obsolete installed dependency packages were pruned.

- Root and Desktop TypeScript checks pass.
- Current automated suite: 46 files / 1,425 tests pass, including 923 Desktop,
  340 Gateway, 143 shared/protocol and 19 script tests. Gateway tests use existing
  disposable fixture state/ports; no real service, configuration or native user
  sessions are used.
- Protocol verification regenerates 85 DTO roots without drift; TypeScript/Ajv
  passes 101 round trips and rejects 37 invalid fixtures; Kotlin passes the same
  101 round trips.
- Current Desktop bundle builds with four renderer resources. Its existing
  500 kB chunk advisory is unchanged in scope; no installer is produced.
- `bash scripts/android-build.sh :app:testDebugUnitTest` passes Debug APK, lint
  and 237 JVM tests (32 XML suites, zero failed/error/skipped). No device or
  signing/release action is performed.
- Both Desktop DEB command guards return exit 1 with the explicit P4.4 message.
- A lightweight real GNOME/Wayland Electron startup uses a disposable profile,
  verifies three columns, the exact original Outline SVG, resource hashes,
  preload state and zero renderer errors, then exits. Sandbox/contextIsolation
  remain enabled, Node integration disabled, renderer Seccomp=2/NoNewPrivs=1.
  The unconfigured client does not connect to Gateway.

The default npm Electron launch first failed at this host's unconfigured SUID
helper, before client startup. Reusing the existing P4.1–P4.3 development runtime
and root-owned Chrome helper passed; its Electron executable is byte-identical
to the installed dependency. No helper permissions, AppArmor, system settings
or shared runtime files were changed. This is development startup evidence,
not formal DEB installation acceptance.

After source commit [`541b48e`](https://github.com/rando1ph/oraculum/commit/541b48e0353ce6fde3ac2b7c60c921b662205afd),
`pnpm build` passes for both current products with clean source provenance.
`node scripts/build-gateway-deb.mjs` successfully assembles the Gateway-only
package. Static extraction validates all 64 runtime files against the recorded
size/SHA-256 inventory, 57 bundled dependency notices, package identity/version,
CLI symlink and unchanged service unit. The bundled Node reports v24.21.0.
No legacy UI/theme/Bridge payload is present. This is a local validation artifact,
not a new release or replacement of published Beta assets.

- Local artifact: `oraculum-gateway_2.0.0~beta.3_amd64.deb`
- Size: 30,205,880 bytes
- SHA-256: `1318523d53786f0b8e35960162ec486f7a2b991c7aee8ebdaa363866bcdc0e3e`

The clean-source Desktop bundle was also launched in the same isolated sandbox
and passed the lightweight startup check; its Gateway state is idle with an empty
Endpoint. Its source SHA and renderer manifest hash are in [validation.json](validation.json).

The full Gateway DEB installation verifier includes starting a temporary Gateway,
so this cleanup uses package assembly and static integrity inspection instead.
No host install or service start occurs. The large GNOME/performance/fault/live
Codex matrix is not repeated.

## Protection and publication

All 325 tracked files under Gateway source, Android app, Desktop source, design,
Gateway Protocol, Gateway packaging and license notices are byte-identical to
the accepted baseline. Product package declarations and documentation are the
only changes outside retired code and repository/build entrypoints. The six
Gateway service properties (state, substate, PID, invocation, start time and
restart count) remain equal before/after; the service stays active/running with
zero restarts. Private service configuration and application/user data are not
read or modified. Local tag refs remain identical; no Release API was used.

The source commit was pushed normally to `origin/main`, and HEAD, origin/main
and `git ls-remote` matched `541b48e0353ce6fde3ac2b7c60c921b662205afd`. The final documentation/evidence
commit and remote SHA are recorded in the linked Notion task after publication.
The task remains **In progress**, awaiting user review. P4.4 remains unstarted.
