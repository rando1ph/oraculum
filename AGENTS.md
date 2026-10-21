
# Oraculum — Agent Instructions

## Source of Truth

The canonical project specification is maintained in Notion:
https://app.notion.com/p/3ff5421e690b81bdae14c0675f0b3acf

- Read the Notion Project and relevant Task before starting substantive work.
- Notion takes precedence over historical conversations and local documentation for project decisions.
- If Notion is inaccessible, report the limitation. Do not invent requirements or alter established architectural decisions.

## Core Principles

- Oraculum (神谕) is a private Ubuntu and Android GUI for the official Codex Harness.
- Never reimplement the agent loop, tool execution, context management, or model orchestration.
- Prioritize usability, visual quality, stability, and maintainability.
- Preserve unrestricted UI customization through the approved Live UI architecture.
- Follow the principle of least complexity. Avoid unnecessary abstractions, dependencies, and infrastructure.
- Keep product configuration portable: HTTPS Origin and Base Path (default `/`) are deployment/build inputs. Never hardcode this user's VPS, IP, proxy, SSH alias, or `/oraculum/` path into product logic; preserve local root-path operation.

## Engineering Workflow

- Inspect the existing code and relevant specifications before modifying anything.
- Prefer minimal, maintainable changes over broad rewrites.
- Run relevant tests and checks; distinguish verified results from assumptions.
- Do not alter existing VPS services, network configuration, credentials, or production deployments without explicit authorization.
- After substantial work, record changes, test results, limitations, and next steps in the appropriate Notion Task.
- Obtain approval before changing frozen architectural decisions.

## Git Workflow

- After each independent, verifiable implementation step, run relevant tests and safety checks, review staged changes, and create a focused Conventional Commit.
- Safely merge each completed step into `main`, then push `origin/main` for review. This publication workflow is authorized by the Notion Project decision dated 2026-10-21.
- Protect existing uncommitted user changes. Do not overwrite, discard, or include them in a task commit without authorization; use an isolated worktree when needed.
- Never force-push, rewrite existing history, bypass branch protections, or overwrite remote commits. Stop synchronization and report unresolved conflicts, failing checks, or suspected secrets.
- Never commit secrets, credentials, sensitive logs, caches, temporary files, or generated build artifacts.
- Record test evidence, limitations, commit hashes, merge results, and verified push status in the relevant Notion Task after each completed step.
- GitHub publication does not authorize VPS, Caddy, SSH, systemd, network, credential, or production service changes. Obtain separate explicit approval after presenting exact impact, backup, and rollback plans.
- Keep the Phase Task `In progress` until the user or an explicitly authorized reviewer accepts it; do not mark it Done yourself.
