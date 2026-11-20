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

## Ubuntu Desktop Beta 1

[Download Oraculum Desktop 2.0.0 Beta 1](https://github.com/rando1ph/oraculum/releases/tag/desktop-v2.0.0-beta.1)
for Ubuntu amd64. The independent Pre-release includes the DEB, source and
artifact metadata, release notes and SHA-256 checksums. See the
[Desktop guide](apps/desktop/README.md) for installation, removal, build and
verification. The interface is in Simplified Chinese.

## License

Original Oraculum 2.0 code is available under [Apache-2.0](LICENSE).
See [NOTICE](NOTICE) and [third-party and brand resources](THIRD_PARTY.md) for
upstream licenses, notices and the scope of the brand assets.

[Documentation index](docs/README.md) distinguishes current guides from
historical records.
