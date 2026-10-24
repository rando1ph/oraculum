# Phase 4D.2 — native session lifecycle

Evidence for the [4D.2 Notion Task](https://app.notion.com/p/4035421e690b81478330e2da3c951f57). Notion remains the specification, and the Task stays **In progress** pending independent review. This work covers archive, restore, and deletion only.

## Native contract checked on 2026-10-24

The installed runtime is `codex-cli 0.160.0`. Both stable and experimental JSON schemas were freshly generated outside the repository. Stable schema bundle SHA256 is `8683f6fd9fbb994fa2bfb704ab5b02c9890238fa507a4c0ff33ff45884cd0a2e`, matching the existing build input in `protocol.lock.json`. This records the tested runtime and reviewed build schema; it does not introduce a runtime version pin.

| Native request | Parameters used | Successful response and notifications |
| --- | --- | --- |
| `thread/list` | `cwd`, pagination, `modelProviders: []`, `archived` | `{ data: Thread[], nextCursor }`; `archived: true` selects archived threads only, while false/omitted selects active-list threads |
| `thread/read` | `{ threadId }` | `{ thread }`, including current runtime `status`; works for archived threads without resuming them |
| `thread/archive` | `{ threadId }` | `{}` and `thread/archived` for each archived thread |
| `thread/unarchive` | `{ threadId }` | `{ thread }` and `thread/unarchived`; restoration does not load the thread for execution |
| `thread/delete` | `{ threadId }` | `{}` and `thread/deleted` for each deleted thread; accepts persisted active-list and archived threads |

All five methods are present in the stable schema and do not require `experimentalApi`. The `Thread` schema has no stable archived flag: use the native list filter and lifecycle notifications, not an inference from a rollout path. Runtime status is `idle`, `notLoaded`, `systemError`, or `active`; active flags include `waitingOnApproval` and `waitingOnUserInput`.

The [official App Server documentation](https://learn.chatgpt.com/docs/app-server) describes archive as attempting to archive spawned descendants, with possible partial descendant failure. Deletion permanently removes the persisted thread and spawned descendants. Restoration only promises to restore the requested thread. Fork ancestry is distinct from spawned-child ancestry. These documented cascade semantics require project/child ownership checks before calling the native mutation; a successful root archive is not proof that every descendant was archived.

Stable `thread/list` defaults to interactive sources, so ordinary history results cannot prove that no subagent exists. Its explicit `sourceKinds` include the subagent variants. `ancestorThreadId` and `parentThreadId` filters are experimental in this installed schema; stable callers must not silently rely on them.

## Isolated native probes

Probes used a new temporary `CODEX_HOME` and workspace, an unreachable loopback model provider, and only newly created test threads. No user history, credentials, or global configuration was edited. Lifecycle calls went to the actual installed App Server; no model inference or tool execution is claimed.

- A persistent test thread was archived, listed in the archived view, read while archived, restored, and permanently deleted through native RPC. The expected archive/restore/delete notifications were received. Archive unloaded the thread; restored metadata reported `notLoaded`.
- Deletion succeeded for both an archived thread and a restored active-list thread. Reading the deleted thread returned native error `-32600`. Repeating deletion also returned `-32600` (`no rollout found`), so the operation is not assumed to be idempotently successful.
- An ephemeral thread could not be archived (`no rollout found`) or deleted (`thread is not persisted and cannot be deleted`). Empty persistent threads remained absent from the ordinary list even after archive/restore and a delay, despite successful native reads. They appeared after a turn was started. Direct native deletion of a newly started empty persistent thread succeeded. List absence alone does not establish deletion; Oraculum must avoid offering an archive/restore flow that would make an empty thread unreachable.
- **Native archive and deletion accepted a running thread.** After `turn/start`, a metadata read explicitly reported `active`, but both operations still returned success in separate isolated cases. Immediately after a successful turn-start response, a read could also briefly report `idle`. The Bridge must therefore guard both fresh native state and its own in-flight requests, turn projection, approvals, and send receipts; native mutation APIs do not provide this safety policy.

Archive and deletion must reject an unsafe or unproven state rather than silently interrupt a turn or discard approval/unknown-send state. A transport failure after a mutation is an unknown outcome, not permission to retry automatically. Older/incompatible native servers must surface an honest capability/error result. Direct JSONL/SQLite/rollout cleanup is never a substitute for a native API.

## Verification and delivery

The shared UI adds per-session actions, active/archived lists, native restore, and a separate permanent-delete confirmation with Cancel initially focused. Lifecycle notifications invalidate stale lists, snapshots, selected composers, and confirmations on other devices. Unsent drafts remain available after restoring a thread.

The Bridge revalidates registered project/cwd ownership, reserves operations against racing sends/resumes, and checks native status, pending interactions and persisted send receipts. Because native archive/delete cascade, historical active and archived sources are scanned for spawned-child dependencies, including other projects; these private metadata are never exposed to the UI. Ambiguous or dependent threads are refused. A stale list reply cannot undo a lifecycle event. Unknown outcomes are never automatically retried; delete success is not inferred from list absence.

| Check | Result / scope |
| --- | --- |
| `pnpm check` | TypeScript passes |
| `pnpm test` | 268 tests pass, including lifecycle, authentication, project, native request and receipt regressions |
| `pnpm build` | Shared production web build passes |
| `pnpm test:lifecycle:ui` | Seven deterministic contract groups through the real Bridge, Electron and Chromium mobile viewport: unsafe states, failed query, confirmation/focus, cross-device changes, unsupported RPC, stale list and stale snapshot/draft recovery |
| `pnpm test:lifecycle:android` | Real Codex 0.160.0 + authenticated source Bridge + Electron + HONOR REA-AN00 / Android 15 Debug WebView over USB ADB reverse: archive/restore, cancel/delete, active and archived delete, native read-after-delete failure, reload and both-client synchronization |

The live script uses an isolated `CODEX_HOME`, trust store and project. Test history is created with an interrupted turn pointed at unreachable loopback, with no model inference or tool execution. Android cookies/storage are backed up privately, restored and checked; the global Codex configuration remains byte-identical. The script closes its test processes and preserves the installed service's stopped state. `pnpm test:lifecycle:live` runs the same native flow with an explicitly emulated mobile client when no Android device is connected. Evidence is ignored under `.local/evidence/phase4d2`; the original Notion Task contains the final report and three viewable UI images.

Current limits: empty persistent threads are absent from native active lists, so a new empty thread cannot be archived, but can be explicitly deleted. Threads with spawned-child dependencies or unprovable lineage remain protected rather than cascaded by the GUI. The relationship scan is bounded to 100 pages per state and fails closed if incomplete. Older native servers can report unsupported methods without any filesystem fallback. There is no native atomic compare-and-delete API; serialization covers this Bridge's clients, not independent external App Server processes. Android Release, public-network/lock-screen coverage and production package deployment are outside this test.

The user authorized stopping the idle installed `oraculum-bridge.service` and temporarily serving source builds on the local Bridge entry point for Android Debug/ADB testing. The formal service must remain stopped after testing; starting it again is the user's decision. This does not authorize production package replacement, proxy/VPS changes, or Phase 4D.3–4D.6 work.
