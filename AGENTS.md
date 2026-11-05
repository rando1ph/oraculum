
# Oraculum — Agent Instructions

## Source of Truth

The canonical project specification is maintained in Notion:
https://app.notion.com/p/3ff5421e690b81bdae14c0675f0b3acf

- Read the Notion Project and relevant Task before starting substantive work.
- Notion takes precedence over historical conversations and local documentation for project decisions.
- For theme development, read `docs/THEMING.md` (Theme API v1 authoring and safety contract).
- If Notion is inaccessible, report the limitation. Do not invent requirements or alter established architectural decisions.

## Core Principles

- Oraculum (神谕) is a private Ubuntu and Android GUI for the official Codex Harness.
- Never reimplement the agent loop, tool execution, context management, or model orchestration.
- Prioritize usability, visual quality, stability, and maintainability.
- Preserve UI customization through approved Trusted CSS Themes; React/JS changes use the normal reviewed development workflow, not Live UI hot deployment.
- Follow the principle of least complexity. Avoid unnecessary abstractions, dependencies, and infrastructure.
- Keep product configuration portable: HTTPS Origin and Base Path (default `/`) are deployment/build inputs. Never hardcode this user's VPS, IP, proxy, SSH alias, or `/oraculum/` path into product logic; preserve local root-path operation.

## Engineering Workflow

- Inspect the existing code and relevant specifications before modifying anything.
- Prefer minimal, maintainable changes over broad rewrites.
- Run relevant tests and checks; distinguish verified results from assumptions.
- Do not alter existing VPS services, network configuration, credentials, or production deployments without explicit authorization.
- After substantial work, record changes, test results, limitations, and next steps in the appropriate Notion Task.
- Obtain approval before changing frozen architectural decisions.

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
