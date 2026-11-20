# Documentation index

Current architecture and task authorization are maintained in the
[Oraculum 2.0 Notion canon](https://app.notion.com/p/4135421e690b815eb404c3024c860134).
The [repository guide](../README.md) describes the active products and commands.

## Current guides

- [Gateway](../gateway/README.md): standalone runtime, HTTP/WS contract and DEB verification.
- [Gateway Protocol](../packages/gateway-protocol/README.md): shared schema and generated clients.
- [Desktop](../apps/desktop/README.md): Ubuntu Beta 1, DEB build, profiles, IPC and local persistence.
- [Android Phase 3](../upgrade/phase3/README.md): native Compose implementation and engineering evidence.
- [Android Studio handoff](../upgrade/phase3/ANDROID_STUDIO_AGENT_HANDOFF.md): user-directed visual refinement.
- [Release guide](RELEASE.md): current Desktop, Gateway and Android release entrypoints, followed by historical release records.
- [P4.3.5 cleanup](../upgrade/phase4/p435/README.md): accepted cleanup and retained dependencies.

## Historical records

The other documents in this directory preserve earlier engineering decisions,
acceptance evidence and releases. In particular, `PHASE_*`, `R1_*`,
`CHANGELOG_BRIDGE.md`, `CHANGELOG_DESKTOP.md`, `COMPONENT_RELEASES.md`,
`REMOTE_CONFIGURATION.md`, `RUNTIME_CONFIGURATION.md`, `THEMING.md` and
`THEME-ASSETS.md` describe the retired Bridge/Web UI/Desktop architecture.
`GATEWAY_BETA_2.md` records a prior Gateway release.

P4.3.5 removes the old implementation and its dedicated build/test/release
scripts. Commands and source links in historical records describe their original
revision and may no longer resolve on `main`; use the relevant Git revision or
published tag to inspect that implementation. Their earlier deployment approvals
do not authorize present service, configuration or user-data changes. Theme API
v1 is not a supported extension point for the new clients.

Phase 0–4 research, approved brand/design assets and acceptance material under
`upgrade/` and `design/` remain preserved. These records are not active runtime
dependencies and do not restore retired packaging or compatibility obligations.
