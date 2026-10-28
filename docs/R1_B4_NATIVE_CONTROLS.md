# R1-B4 native session controls

Specification: Notion Task `4075421e690b81f3b9c0c0c2dc6eea6e` and the Oraculum Project. This is a source implementation; it does not change the installed release or authorize packaging/deployment.

## Compatibility evidence

The installed `codex-cli 0.164.0` exported stable and experimental schemas into an isolated temporary directory on 2026-10-29. Thirteen relevant method/response/notification TypeScript definitions match the reviewed 0.160.0 build inputs byte for byte. The CLI and `protocol.lock.json` remain unchanged. Runtime compatibility is checked by response shape, independently from the build schema version.

| Action | Native contract | Scope |
| --- | --- | --- |
| Rename | `thread/name/set`, `thread/name/updated` | Native name only; no private name database. |
| Fork | `thread/fork` | New persistent thread in the same authorized project cwd; shares host files. Stable `lastTurnId` is available; no experimental fork fields or worktrees. |
| Supplement | `turn/steer` | Requires the observed `expectedTurnId`; never falls back to `turn/start`. |
| Review | `review/start` | Inline review of `uncommittedChanges`, using native Turn, approval and result events. |
| Compact | `thread/compact/start` | Empty response acknowledges start; completion comes from native Turn/contextCompaction events. |
| Revert | `thread/revert` | `beforeTurnId` excludes the selected Turn and all later history. Requires confirmation. Reloads native paginated history because the response's `thread.turns` is empty. Does not undo files. |
| Plan | `collaborationMode/list`, `turn/start.collaborationMode` | Unavailable on the default stable connection. No prompt simulation. |

The fresh 0.164.0 stable schema bundle SHA256 is `5f633ad1f0a07459a5f63ed5604f8a61e0366ac5c36a15d648b44c8de4ffafb1`. The experimental bundle SHA256 is `92fe055424a3709999a05baae615be9e1e1e0b127e033cace6849b2ea785ea07`.

Plan negotiation was checked read-only with both temporary `CODEX_HOME` and cwd. With `experimentalApi=false`, `collaborationMode/list` returns `-32600` requiring the experimental capability. With true, it lists native Plan/Default presets. The turn parameter is absent from the stable schema and overrides model, reasoning effort and developer instructions. The existing single App Server connection negotiates a global experimental capability, without a Plan-only opt-in. B4 therefore keeps `experimentalApi=false` and explains availability in the UI. Separate process routing and its approval/history/recovery implications are outside this batch.

## Safety and recovery

All six mutations carry unique operation IDs. Bridge delivery metadata contains no instructions, names, review targets, credentials or copied conversation history. Duplicate IDs and unresolved operations are guarded; disconnects and unknown results never cause automatic retries. Querying status is a read, not permission to replay a mutation.

The Bridge checks project ownership, native cwd, parent/child relationships, active execution, pending approvals and current device authorization before native mutations. Steer uses its own active-Turn guard. Native unsupported-method errors disable only the affected action.

Native Revert and Compact invalidate historical pages using a persistent revision. The shared renderer clears stale items, approvals, receipts, Diff and Plan projections, then reads native history again. Old snapshots, pages and late events from removed Turns cannot restore reverted history.

Fork, Review, Compact and Revert conservatively refuse native child dependencies, including hidden, archived or other-project children. Unidentified operation outcomes may remain unknown after a read or restart; an unrelated idle state or later Turn cannot prove success. Unknown Review/Compact/Revert also block new sends. The UI offers Fork from the current completed conversation; the Bridge additionally validates stable `lastTurnId` when supplied by a client. Review UI currently offers uncommitted changes only. Archived/ephemeral/child thread actions retain conservative boundaries rather than bypassing native checks.

## Verification boundaries

Run `pnpm check`, `pnpm test`, `pnpm build` and `pnpm test:session-controls:ui`. The latter uses the real Bridge, Ubuntu Electron and Chromium phone viewports with deterministic native fixtures, temporary profiles and isolated directories. It does not exercise real user sessions, Android devices, ADB, release signing or production services. Existing message, usage, Composer, theme, permissions, lifecycle and trust UI contracts provide regression coverage.

No native Queue, search, model/effort policy change, B5–B8 work, DEB/APK build or deployment is included. The formal Task stays In progress pending independent review and user acceptance.
