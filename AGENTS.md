
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

## Engineering Workflow

- Inspect the existing code and relevant specifications before modifying anything.
- Prefer minimal, maintainable changes over broad rewrites.
- Run relevant tests and checks; distinguish verified results from assumptions.
- Do not alter existing VPS services, network configuration, credentials, or production deployments without explicit authorization.
- After substantial work, record changes, test results, limitations, and next steps in the appropriate Notion Task.
- Obtain approval before changing frozen architectural decisions.

