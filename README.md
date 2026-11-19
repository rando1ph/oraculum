# Oraculum 2.0 · 神谕

Oraculum is an independent client for the official Codex App Server. The App
Server remains the sole authority for execution, native conversations and
approvals. The repository contains three independently built products:

| Product | Source | Build and architecture guide |
| --- | --- | --- |
| Gateway | `gateway/` | [Gateway](gateway/README.md) |
| Ubuntu Desktop | `apps/desktop/` | [Desktop](apps/desktop/README.md) |
| Native Android | `apps/android/` | [Android Phase 3](upgrade/phase3/README.md) |

`packages/gateway-protocol/` defines the client-facing Gateway contract.
`packages/shared/` contains the MCP elicitation form validation shared by Gateway
and Desktop. The official App Server protocol is generated into ignored local
build inputs under `.local/codex-protocol/`. Brand originals
remain under `design/`; approved architecture, design and acceptance records
remain under `upgrade/`.

Project decisions and task authorization come from the
[Oraculum 2.0 Notion canon](https://app.notion.com/p/4135421e690b815eb404c3024c860134).
Read [AGENTS.md](AGENTS.md) before making changes.

## Development

Use Node 24 and the pnpm version pinned in `package.json`:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build:desktop
```

The generated official protocol must be present before checking or building;
its pinned generation contract is in `protocol.lock.json` and
`scripts/generate-protocol.mjs`. Gateway client schema generation and verification
are documented in [Gateway Protocol](packages/gateway-protocol/README.md).

`pnpm desktop` builds and starts the independent Desktop bundle. It does not
start or manage Gateway. `pnpm build` builds Desktop and the standalone Gateway
runtime; the Gateway build requires a clean committed source tree and records
its exact source identity. `pnpm build:gateway:runtime` builds Gateway alone.
These commands do not install software or change running services.

For Android host-side checks, use the existing wrapper from the repository root:

```bash
bash scripts/android-build.sh :app:testDebugUnitTest
```

Android installation, signing and publication are separate operations. See the
[release guide](docs/RELEASE.md) for the existing signing and Gateway package
contracts; a build does not authorize installation or service changes.

## Desktop packaging status

P4.0–P4.3 are accepted. [P4.3.5](upgrade/phase4/p435/README.md) removes the retired
Bridge, shared Web UI, Theme API v1 and the old Desktop 0.2.0 runtime and packaging
chain. `pnpm build:desktop` produces the current runnable development bundle.
`build:desktop:deb` and `verify:desktop:deb` fail with an explicit P4.4 pending
message. They cannot build or validate the retired package.

P4.4 will define the new Desktop DEB contract after separate authorization. There
is no active Bridge/Desktop candidate workflow or combined `build:deb` command.
Published tags and Release assets are preserved; historical source is available
through Git history. No legacy user data is migrated or removed by this cleanup.

[Documentation index](docs/README.md) distinguishes current guides from historical
records, whose old commands are not current development or deployment entrypoints.
