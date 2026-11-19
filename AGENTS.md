# Oraculum — Agent Instructions

## Source of Truth

The current Oraculum 2.0 project canon is maintained in Notion:
[神谕升级｜Oraculum 2.0](https://app.notion.com/p/4135421e690b815eb404c3024c860134).

The [original Oraculum project](https://app.notion.com/p/3ff5421e690b81bdae14c0675f0b3acf) remains the historical/legacy reference.

- Read the Notion Project and relevant Task before starting substantive work.
- Notion takes precedence over historical conversations and local documentation for project decisions.
- For legacy Desktop/Bridge CSS theme work only, read [docs/THEMING.md](docs/THEMING.md) (Theme API v1 authoring and safety contract); it is not the Android Compose visual development path.
- If Notion is inaccessible, report the limitation. Do not invent requirements or alter established architectural decisions.

## Core Principles

- Oraculum (神谕) 2.0 consists of a native Android Kotlin + Jetpack Compose client, an independent TypeScript/Node Oraculum Gateway connected to the official Codex App Server, and an independent Electron + React + TypeScript Ubuntu Desktop client in development. The old shared Web UI/Desktop/Bridge is legacy. The latest Notion P4.1 authorization supersedes the earlier Desktop deferral.
- The official Codex App Server is the sole execution authority. Never reimplement the agent loop, tool execution, context management, or model orchestration.
- Prioritize usability, visual quality, stability, and maintainability.
- Approved Trusted CSS Themes and Theme API v1 apply only to the legacy Desktop/Bridge UI; retain their contracts and documentation while legacy consumers remain. Legacy React/JS changes use the normal reviewed development workflow, not Live UI hot deployment. Live UI hot deployment remains prohibited; Android visual changes use the normal source review workflow.
- Follow the principle of least complexity. Avoid unnecessary abstractions, dependencies, and infrastructure.
- Keep product configuration portable: HTTPS Origin and Base Path (default `/`) are deployment/build inputs. Never hardcode this user's VPS, IP, proxy, SSH alias, or `/oraculum/` path into product logic; preserve local root-path operation.

## Android Visual Work

- Use native Kotlin + Jetpack Compose and the existing Material 3 Expressive design system; do not port legacy CSS themes or shared React pages into Android.
- Follow the user's latest visual feedback and approved Stitch/Oracle Eye assets. Preserve existing functionality and safety semantics; obtain direction before major design or information architecture changes.
- For user-directed Android Studio visual refinement, read [upgrade/phase3/ANDROID_STUDIO_AGENT_HANDOFF.md](upgrade/phase3/ANDROID_STUDIO_AGENT_HANDOFF.md) and wait for the user's page/item instructions before changing UI.

## Ubuntu Desktop P4.3

- Follow the [current P4.3 Task](https://app.notion.com/p/41d5421e690b81f1a436d23dc3f30ba7). P4.0–P4.2 are accepted, with P4.2 finally accepted on 2026-11-19 at `85b303c`. Their approved three-column layout, Light / Dark / OLED Dark tokens, complete Outline Oracle Eye SVG, original Diff font size and independent Electron security boundary remain the baseline.
- P4.3 adds IndexedDB history, scoped drafts, reading-position recovery, offline reading, long-conversation performance and mature keyboard/mouse interaction. Preserve P4.2 main-process Gateway Protocol 2.1 communication, system-protected credentials, durable write receipts and recovery. Cache data never grants write or approval authority; unknown writes only query their original operationId and are never automatically replayed.
- The new Desktop does not import legacy themes, Theme API v1, Bridge transport or service lifecycle code. Preserve historical source files without putting them in the new runtime.
- Use the existing running Gateway Beta 3 only through its formal local loopback HTTP/WS APIs, with an independent Desktop device identity and dedicated test project/sessions. Do not modify, restart, stop, upgrade or replace Gateway, alter private configuration/network/systemd, or deploy a test Gateway. Use fixtures for disruptive failure scenarios. HTTPS/WSS remains configurable but has no real remote/TLS acceptance in P4.2.
- Use the dedicated client profile and test resources for real GNOME/Wayland verification. Do not build/install a formal DEB, publish a release or advance to P4.4. Keep P4.3 In progress pending user review. Clear-history and appearance recovery must preserve drafts, credentials and the main journal.

## Engineering Workflow

- Inspect the existing code and relevant specifications before modifying anything.
- Prefer minimal, maintainable changes over broad rewrites.
- Run relevant tests and checks; distinguish verified results from assumptions.
- Keep credentials, pairing tokens, sensitive logs and private deployment details out of source, documentation and diagnostic output.
- Do not alter existing VPS services, network configuration, credentials, or production deployments without explicit authorization.
- After substantial work, record changes, test results, limitations, and next steps in the appropriate Notion Task.
- Obtain approval before changing frozen architectural decisions.
- Preserve published Beta 1 tags, Release assets and checksums; subsequent changes require new source commits and future Beta releases, not overwriting the published baseline.

## Android Release Signing

- A user instruction to “签名 APK” or “构建并发布 APK” authorizes the requested signing/release work. Use `python3 scripts/android-signing.py release --auto` (with `--apk` for a reviewed existing unsigned build); do not ask again for passwords, hashes, authorization confirmations, one-time codes, or manual approval.
- Read the existing Ubuntu Secret Service items through the launcher; passwords go only to apksigner stdin. Preserve the original JKS, certificate, offline backup, existing APKs and all identity/integrity checks. Compute and verify public hashes autonomously; never print secrets or pass them through arguments, environment variables or plaintext files.
- Keep the interactive mode available. Missing credentials or failed verification must stop safely with a concrete report. Signing/release authorization does not authorize installation, state migration or production service/network changes.

## Git Workflow

- Develop only on `main` in `~/Projects/Oraculum`. Do not create branches or worktrees per Phase or task. Fetch and verify `origin/main` before starting; use fast-forward-only updates and stop on divergence.
- After each independent, verifiable implementation step, run relevant tests and safety checks, review staged changes, and create a focused Conventional Commit.
- Commit completed steps directly on `main`, then normally push `origin/main` for review under the Notion Project's authorized publication workflow. Verify local and remote commit IDs match.
- Protect existing uncommitted user changes. Inspect and preserve them before integration; stop and report changes whose ownership or intended treatment is unclear. Do not create an isolated worktree to bypass this requirement.
- Remove old branches only after verifying all their commits are in `origin/main`. Remove old worktrees only after preserving private/untracked data and confirming no running service or process depends on their paths; otherwise retain them and report the blocker. Retained worktrees are not development workspaces.
- Never force-push, rewrite existing history, bypass branch protections, or overwrite remote commits. Stop synchronization and report unresolved conflicts, failing checks, or suspected secrets.
- Never commit secrets, credentials, sensitive logs, caches, temporary files, or generated build artifacts.
- Record test evidence, limitations, commit hashes, merge results, and verified push status in the relevant Notion Task after each completed step.
- GitHub publication does not authorize VPS, Caddy, SSH, systemd, network, credential, or production service changes. Obtain separate explicit approval after presenting exact impact, backup, and rollback plans.
- Keep the Phase Task `In progress` until the user or an explicitly authorized reviewer accepts it; do not mark it Done yourself.
