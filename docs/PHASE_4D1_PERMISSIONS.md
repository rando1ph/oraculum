# Phase 4D.1 — native permission selector

Implementation/verification record for the [4D.1 Notion Task](https://app.notion.com/p/4035421e690b8199b339fd9c4a1968c3). Notion remains the specification; this task stays **In progress** pending user and independent review. No 4D.2–4D.6 work or production installation is included.

## Native contract verified on this host

Installed `codex-cli 0.160.0`; freshly generated schema SHA256 matches `protocol.lock.json`: `8683f6fd9fbb994fa2bfb704ab5b02c9890238fa507a4c0ff33ff45884cd0a2e`. This is evidence, not a new runtime version lock.

| Choice | Thread start | Turn start |
| --- | --- | --- |
| Inherit | Omit permission fields; native project configuration resolves defaults | Omit permission fields; retain the native thread's current settings |
| Read Only | `approvalPolicy: on-request`, `sandbox: read-only` | `approvalPolicy: on-request`, `sandboxPolicy: readOnly`, network disabled |
| Auto | `approvalPolicy: on-request`, `sandbox: workspace-write`; thread-local workspace sandbox options request default roots/network/tmp behavior | `approvalPolicy: on-request`, `sandboxPolicy: workspaceWrite`; request no extra roots, network disabled, normal temporary directory handling |
| Full Access | `approvalPolicy: never`, `sandbox: danger-full-access` | `approvalPolicy: never`, `sandboxPolicy: dangerFullAccess` |

Reviewer routing stays native; Auto here is the workspace-write permission preset, not a request to enable automatic review. Read Only is a read-only sandbox with native on-request approvals, not a promise that approved escalations can never write. No user/global configuration is written. The renderer cannot supply arbitrary native configuration, sandbox policies, cwd changes, or reviewer overrides.

Important observed semantics:

- `turn/start` overrides persist for this **and subsequent turns**. Switching to Inherit does not reset the previous override. The Composer says this explicitly. Select Read Only or Auto to request narrower permissions; new inherited threads resolve the project's native defaults.
- An already-loaded `thread/resume` ignores permission overrides. Oraculum uses it without policy overrides to read actual state, not to pretend a switch occurred.
- Stable API emitted no `thread/settings/updated` in the real probe. The Bridge reads native settings after an accepted turn, broadcasts the confirmed result, and refreshes on subscription/reconnect. If a compatible server sends the native notification, it also updates the projection.
- Empty fresh threads may have no rollout yet; the authoritative `thread/start` reply supplies their settings. Metadata-only resume of legacy JSONL threads can fail with `-32601: list_turns is not supported yet`; only this error triggers the official resume-with-history fallback.
- Existing threads can retain native configured additional writable roots even when Auto requests `writableRoots: []`. The actual native reply is authoritative. The UI shows additional-root count and retains expandable full native settings. New Auto threads use only a thread-local sandbox config override; no global settings change.
- Cold resume can resolve a different combination of policy and sandbox from the running thread. Oraculum displays the returned combination, including custom settings; it does not reconstruct effective permissions from a saved mode label.

Official context: [App Server](https://learn.chatgpt.com/docs/app-server), [approvals and sandbox security](https://learn.chatgpt.com/docs/agent-approvals-security). Generated local types and installed-binary probes take precedence over differing online examples for this host's protocol spelling.

## State and safety

The shared Ubuntu/Android Composer keeps the user's next-action choice separate from native confirmed settings. It defaults to Inherit, never persists Full Access as a client default, resets intent on thread/project changes and reconnect, and labels disconnected values as previously confirmed. A choice only takes effect on the next create/send; it does not change an active turn.

An explicit turn change invalidates the cached permission display. Native ACK immediately preserves the accepted send receipt; permission readback runs separately. Failed readback becomes unconfirmed with a notice, never a fake success or an automatic resend. Query epochs prevent older replies/failures from replacing newer state, and readback checks both thread ID and project cwd. Existing device authorization, approvals/tokens, project ownership, and send deduplication remain in place.

## Verification

- `pnpm check`; targeted Vitest suites cover permissions, store/display, native routing, approvals, receipts, project ownership, device trust, recovery/lifecycle, and history fallback.
- `pnpm build` produces the shared production Web UI.
- `pnpm test:permissions:native` uses the real installed App Server and real Bridge, a temporary CODEX_HOME/project, in-memory receipt storage, and an unreachable loopback provider. It confirms new-thread presets, inherited project settings, five independent turn transitions (Read Only → Auto → Full Access → Inherit → Read Only), actual readback, terminal/receipt handling, and isolated Bridge/App Server restart. All turns are deliberately interrupted: **no model inference or tool execution is claimed**. The real global config hash remains unchanged.
- `pnpm test:permissions:ui` uses actual Ubuntu Electron and Chromium mobile emulation against the real Bridge with deterministic native fixtures. It checks selected versus effective state, switching/reload, cross-client updates, and responsive controls; it is not a real-model or Android-device test.
- `bash scripts/android-build.sh`: Debug assembly and lint only. Existing SDK XML/deprecated Android API warnings remain; no release signing, APK installation, or ADB operation.

Local generated evidence stays ignored under `.local/evidence/phase4d1/`. No existing Bridge/service, systemd, proxy, VPS, Caddy, SSH, installed DEB/APK, real login, MCP, Skills, or user project data was changed. Deployment and Android device acceptance remain deferred.

Rollback is an ordinary reviewed Git revert followed by the project's separately authorized build/deployment process; no data migration or global configuration rollback is required.
