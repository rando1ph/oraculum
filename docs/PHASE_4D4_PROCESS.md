# Phase 4D.4 · Codex execution process

Authority: [Notion Task](https://app.notion.com/p/4035421e690b81bf8b5aff9264418c63), the latest [Project](https://app.notion.com/p/3ff5421e690b81bdae14c0675f0b3acf), and the user's original DOCX p8–p12. This is an implementation/testing note, not a replacement specification or acceptance decision.

## Behavior

- Shared Ubuntu/Android UI groups actual items under their native Turn in native order. Running commentary, public reasoning summaries, commands, tools, file changes and plans remain available. Completed turns fold their process into a compact status/time/count row. Final answers remain normal message cards.
- Only `agentMessage.phase = commentary` is classified as progress. `final_answer`, null, omitted and unfamiliar phases stay visible; no heuristic guesses from wording or “last message.”
- Completed duration uses native `durationMs`, then native `completedAt - startedAt`. Running elapsed uses native `startedAt` (seconds) and the current clock. Missing timestamps produce no invented duration; disconnect/synchronization stops the elapsed display until state is confirmed.
- Failed/interrupted turns remain open. Failed/declined tools, nonzero command exits and known child-agent failures remain visible even if their parent Turn completed. Approvals, connection errors and unknown-send controls remain outside the fold. Child-thread requests only affect the active verified parent turn, never unrelated historical turns.
- Expand exposes original command/output/exit code, MCP input/result/progress and Diff. Counts use actual Item identities, unique file paths and known child-thread identities. Native Plan and aggregate Diff belong to their own turn; a live plan keeps the last actual Item as its arrival anchor.
- Manual expansion is optional device-local `sessionStorage` reading metadata, keyed by thread/turn. It survives refresh; a newly completed turn defaults to collapsed. Existing item anchors and cards/Composer/theme slots remain intact.

## Native projection

`store.ts` adds reasoning summary/part/text deltas, plan deltas, MCP progress and patch updates. Completed items replace accumulated deltas; buffered overlap and late deltas are ignored. Native snapshots/pages retain native order and observed-only records without persisting a second transcript. Nonempty native Turn payloads can supply missing items; empty payloads never erase observed records. Sparse snapshots retain already observed native timing.

No Harness loop, protocol version lock, production configuration, deployment, DSH Trajectory, historical-completeness warning or 4D.5 feature was added. No synthetic history is generated. Empty reasoning summaries have no fabricated placeholder content.

## Verification entry points

```sh
pnpm check
pnpm test
pnpm build
pnpm test:process:ui
pnpm test:messages:ui
pnpm test:composer:ui
pnpm test:themes:ui
pnpm test:process:live --keep-fixture
pnpm test:process:live --reuse /absolute/path/to/fixture.json
```

`process:ui` uses real Electron and mobile Chromium with controlled protocol fixtures. It covers ordering, phase/timing fallback, live deltas, fold/expand, output/Diff, failures, approvals, stopped turns, pagination, reading anchors, reconnection, unknown-send and themes. It is not a real Codex/Android test.

`process:live` requires the production Bridge already stopped, port 17860 free and the existing Android Debug WebView reachable by ADB. It creates one bounded official Codex task in an isolated scratch directory, uses authenticated source Bridge and a private static-build snapshot, and exercises real Electron plus Android WebView. The task reads/fixes/tests a small file and requests an available read-only MCP call. Its deliberate eight-second command wait is included in the genuine native duration. Reuse mode forbids new threads/model turns and rechecks the same actual result. Device cookies/storage and pre-existing ADB mapping are restored; global Codex config hash and stopped production Bridge are verified. Screenshots and private fixtures stay under ignored `.local/evidence/phase4d4/`.

## Implementation verification

- TypeScript check and production build passed. Unit/integration suite: 314 tests across 31 files. UI contract groups: process 7, messages 8, Composer 8, themes 11, all passed.
- Official Codex 0.160.0 produced a real completed turn with commentary, two command executions, one file change, one read-only MCP call and a distinct final answer. Native duration was 33,106 ms, including the deliberate eight-second wait. Actual Electron and HONOR REA-AN00 / Android 15 captured running elapsed and automatic completion folding.
- The final completed-history recheck passed on Electron and the existing Android Debug app: actual ADB taps, command output/exit code, read-only Diff, collapse/expand, refresh, explicit reconnect and four themes. Reuse started zero new turns. Report: `.local/evidence/phase4d4/live-YwMakz/acceptance.json`; running screenshot: `live-q9ituZ/electron-running.png` under the same evidence directory.
- Both runner-created threads (including an earlier interrupted attempt) were deleted through the official API. Device cookies/storage and ADB mapping were restored; the temporary Bridge port was released and the installed Bridge remained stopped. No global Codex configuration changed.
- Live runs did not generate public reasoning summaries, child-agent activity, approvals or failures. Those paths, long-history paging and unknown-send were verified with controlled native-schema fixtures, not claimed as live model/device event evidence. Harness-only failures during acceptance were corrected and rechecked against the same completed native turn.

## Limits

- Missing native history, plan notifications, timing or public summaries are neither reconstructed nor advertised with completeness warnings. Live-only notifications are held only in the current UI memory; after a full reload only what Codex returns is available.
- Existing unclassified agent messages remain visible even when they might be progress. This protects final output on older/different native contracts.
- Subagent presentation uses only supplied collab/activity items and last-known states; no independent child polling or full trajectory is built.
- Android Release, DEB installation, public network tests and production service deployment remain outside this task. The Task remains `In progress` for independent acceptance.

## 2026-10-25 revalidation

The renewed user request was checked against the latest Notion Project/Task and the original DOCX p8–p12 text and embedded images. The existing implementation at `88af57ce40ac49d3a44ad9a9563f6468709e0d1f` already covers the requested scope; no product changes were needed. Notion contained a later acceptance/Done record. Per this request, the Task was returned to `In progress` for review, preserving the earlier implementation and acceptance history.

- Fresh `pnpm check`, `pnpm test` (314 tests / 31 files), `pnpm build` and `pnpm test:process:ui` (7 groups) passed. The controlled UI checks include public reasoning deltas, native ordering, approvals/failures, paging/reading anchors, unknown-send, reconnection and four themes; those event paths are not all live model evidence.
- Fresh `pnpm test:process:live` passed on real Ubuntu Electron and HONOR REA-AN00 / Android 15 Debug WebView over USB ADB reverse. Exactly one official Codex 0.160.0 Turn produced commentary, two commands, one file change, one read-only MCP call and a separate final answer. Native duration was 31,522 ms, including the deliberate eight-second capture wait.
- Both clients verified advancing elapsed time and Stop while running, automatic completion folding, final-answer visibility, expansion/collapse, actual output/exit code, read-only Diff, refresh, explicit reconnect and four themes. Report: `.local/evidence/phase4d4/live-4FOFzl/acceptance.json`; controlled UI report: `.local/evidence/phase4d4/process-contract/run-mPuqXq/report.json`.
- The runner deleted its own test thread, restored device cookies/storage and the pre-existing ADB mapping, verified unchanged global Codex configuration, and left the formal Bridge `inactive / dead / MainPID=0`. No cleanup errors occurred. Screenshots remain private/ignored locally and are provided in the original Notion Task.
- No 4D.5, full trajectory, history-completeness UI, installation or deployment work was performed. Existing limitations above remain; no new product defect was found.
