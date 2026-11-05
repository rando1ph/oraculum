# Independent Bridge and Desktop release candidates

The Notion project and phase B task authorize source changes, build artifacts and
isolated validation. Phase B does not authorize public GitHub Releases or production
installation. The task stays In progress until independent review and user acceptance.

`release.json.components.bridge.version` and
`release.json.components.desktop.version` are independent stable versions. Their
initial candidate versions are both `0.2.0`; either can advance without rebuilding
the other. The historical top-level `version: 0.1.2` and `androidVersionCode: 4`
remain the existing Android identity. Phase B does not build, sign or modify APKs.

| Component | Package | Tag | Build |
| --- | --- | --- | --- |
| Bridge | `oraculum-bridge` | `bridge-v<version>` | `pnpm build:bridge:deb` |
| Desktop | `oraculum` | `desktop-v<version>` | `pnpm build:desktop:deb` |

`pnpm build:deb` builds both DEBs. Bridge builds the shared Web UI and standalone
runtime; Desktop builds the Electron shell and its own resources, without building
or copying Bridge. Update the matching component changelog when changing a version:
[Bridge](CHANGELOG_BRIDGE.md) or [Desktop](CHANGELOG_DESKTOP.md).

## Local candidate preparation

Develop and commit verified source on `main`, then rebuild from a clean tree so
embedded `build.json` records the exact source commit and `sourceDirty: false`.
On a fresh checkout, install locked workspace dependencies and regenerate the
ignored TypeScript/JSON protocol inputs before checking or building:

```sh
pnpm install --frozen-lockfile
NPM_CONFIG_USERCONFIG=/dev/null NPM_CONFIG_CACHE="$PWD/.local/cache/npm" npm install --prefix .local/codegen --no-save --package-lock=false --ignore-scripts --no-audit --no-fund @openai/codex@0.160.0
mkdir -p .local/codegen-home
CODEX_HOME="$PWD/.local/codegen-home" ORACULUM_CODEGEN_CODEX_BIN="$PWD/.local/codegen/node_modules/.bin/codex" pnpm protocol
```

This private build tool does not replace the user's installed Codex or become a
product dependency. `scripts/generate-protocol.mjs` requires the exact
`codex-cli 0.160.0` identity and schema SHA-256 in `protocol.lock.json` before
publishing generated inputs. The separate empty `CODEX_HOME` needs no login or
model request. Update this pinned build prerequisite only with a reviewed protocol
lock change; a newer runtime Codex can continue to run independently. The
[official App Server schema documentation](https://learn.chatgpt.com/docs/app-server#message-schema)
explains that generated schemas match the CLI version used.

Run each command separately, selecting the component being released:

```sh
pnpm check
pnpm test
pnpm build:bridge:deb
node scripts/verify-bridge-deb.mjs dist/bridge/oraculum-bridge_0.2.0_amd64.deb
node scripts/create-component-release.mjs --component bridge --deb dist/bridge/oraculum-bridge_0.2.0_amd64.deb --output dist/releases/bridge-0.2.0
```

For Desktop:

```sh
pnpm build:desktop:deb
node scripts/verify-deb.mjs dist/desktop/out/make/deb/x64/oraculum_0.2.0_amd64.deb
node scripts/create-component-release.mjs --component desktop --deb dist/desktop/out/make/deb/x64/oraculum_0.2.0_amd64.deb --output dist/releases/desktop-0.2.0
```

`node scripts/release-components.mjs deb-path bridge` (or `desktop`) prints the
current component's versioned DEB path. The candidate command refuses dirty source,
an unexpected Debian package/version/architecture, a different build commit, or
incompatible protocol/state metadata. No package is installed. The candidate
directory contains the selected DEB, `bridge-release.json` or
`desktop-release.json`, `RELEASE_NOTES.md`, and `SHA256SUMS`; Bridge also includes
the self-contained Python 3 `bridge-update.py` APT wrapper. Run
`sha256sum --check SHA256SUMS` from that candidate directory before transfer or use.

Candidates contain no timestamp. Repeating the command with identical inputs
verifies and preserves the directory. A different existing candidate is rejected;
choose a new output directory and retain the previous evidence.

The format 1 manifest records component/version/tag, `sourceRepository`, the full
40-character `sourceGit`, protocol version 1 and the selected amd64 DEB's exact
name, byte count and SHA-256. Bridge also records `stateSchemaVersion: 1`. The
embedded Bridge build identity declares readable state schemas 0–1; installation
preflight and rollback independently check the actual database before changing
software. Hashes detect modification; release provenance relies on obtaining the
manifest and assets from the approved repository/release or a separately verified
review handoff.

## GitHub workflow and later publication

The manually dispatched
[component candidate workflow](../.github/workflows/component-release-candidate.yml)
accepts exactly one component and runs only on the canonical repository's `main`.
It verifies the dispatch commit is still the checked-out `origin/main`, uses pinned
action commits and locked dependencies, checks/tests source, builds the selected
DEB, validates it, and uploads a 30-day review artifact. Its GitHub token has only
`contents: read`; the workflow has no release/tag/publication step. Starting it does
not install software, switch services, or compile Android.

After independent review, a separately authorized publication step can create the
matching immutable version tag at the manifest's exact `sourceGit` and attach the
verified candidate files to a GitHub Release. Do not reuse an existing version/tag
for different bytes. A publication command or workflow is deliberately not enabled
in phase B; future automation must keep review approval explicit, validate tag
provenance, and create a draft until publication is approved. Never publish a
candidate merely because its build passed. GitHub's
[manual workflow documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch)
and [artifact action](https://github.com/actions/upload-artifact) describe the CI
mechanisms; they do not replace the project's authorization boundary.

The Bridge updater selects only approved, non-draft Bridge releases using the
`bridge-v<version>` identity and `bridge-release.json`. Until an approved release
exists, phase B review uses local manifests and DEBs in an isolated environment.
Production installation, configuration inheritance, service-entry switching and
rollback precautions are documented in the phase B handoff and remain a separately
approved phase D operation.
