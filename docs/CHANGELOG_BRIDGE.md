# Oraculum Bridge changelog

## 0.2.0 — review candidate

- Introduces the independent `oraculum-bridge` Ubuntu amd64 DEB, with private Node 24, compiled Bridge, shared Web UI, themes and licenses.
- Uses `/usr/lib/oraculum-bridge` and a separately owned user service unit; installation does not register, enable, start or switch a running service.
- Preserves external runtime configuration, device trust, project registration, attachments and Receipts. Provides explicit state-schema compatibility and a copy-only migration preflight.
- Adds a thin APT installation, update and software rollback tool with release provenance and SHA-256 validation; state snapshots are never restored over newer Receipts.
- Includes the reviewed phase A connection recovery fixes. Protocol version 1 retains compatibility with the existing Android 0.1.2 native container; Android device acceptance remains a later task.

This is a phase B candidate for independent review. It is not authorization to install production software or change services.
