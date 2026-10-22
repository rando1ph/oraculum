# Phase 1+2 host project patch — implementation evidence

Canonical scope and acceptance remain in [the Notion Task](https://app.notion.com/p/4005421e690b818c8fefebf4a3d31dcd). This report records implementation and observed tests; it does not mark the Task accepted.

## Behavior

Both Electron and Android use the same **Browse host folders / Add project** dialog in Project → Session. Navigate the Ubuntu host's `~/Projects` or the existing `~/.cache/oraculum/workspaces` area, then explicitly add an existing directory. There is no copying, Git initialization, worktree creation or phone-local file picker. The project can be removed from the registry without deleting files or native sessions.

The private existing SQLite store now contains canonical project paths and device/inode identity. Only the host-selected default workspace is registered automatically; other folders, including old cache workspaces, require explicit addition. Registrations survive a normal Bridge restart and changes notify connected devices. Same-named projects show full paths. Missing/moved/replaced directories remain visible as unavailable. Remove and explicitly add a changed folder again; the host default cannot be removed through the GUI.

The browser exposes directory names/paths only. Roots come from host policy, not Web requests. Noncanonical, hidden, encoded/traversal and escaping symlink paths are rejected; internal aliases deduplicate to their real path. Each operation rechecks the registry and filesystem identity. Browser pages are bounded to 200 scanned directory entries. No HTTP filesystem route was added: browsing/registration use the existing authenticated, Origin-checked WebSocket.

Native start/list/resume/history/turn/approval retain project ownership, sandbox and approval checks. Renderer-supplied cwd cannot reassign a known thread. Invalid/removed directories block execution and Accept; observed Stop/Decline remain possible. Native resume responses are checked again for cwd. Receipt behavior is unchanged.

A real acceptance run found the old automatic first-session resume could hit another Codex process's active writer lock after registration. First-time addition now selects the project and lists sessions without automatically resuming one. Existing registered project selection retains remembered-session restoration; explicit selection of an externally owned session still respects the native writer lock.

## Verified on 2026-10-22

- `pnpm check`, `pnpm test`: 70 tests passed, covering path/alias/identity changes, durable registry, duplicate/same-name projects, bounded browsing, removed-project controls, native cwd ownership, receipts, authentication, revocation and root/subpath routing.
- `pnpm build` passed.
- `pnpm exec tsx scripts/projects-ui-contract.ts`: simulated native responses with real directory registry; 1440/390 CSS px navigation, independent client registration, immediate list sync, negative paths, removal/unavailable states, isolated drafts and native writer-lock regression.
- `pnpm test:phase3:ui`: all five existing interaction contracts passed.
- `ORACULUM_TEST_REMOTE_BASE=/console/ pnpm test:ui:mock`: local TLS fixture authenticated HTTPS/WSS, resources, pairing/revocation, approval, diff and history UI passed. This is not public-network evidence.
- `scripts/projects-live.ts`: **real Ubuntu Electron 44.9.1 and HONOR REA-AN00 Android 15 WebView**, USB ADB reverse, 369 × 782 CSS px. Existing `~/Projects/Oraculum` registered through Electron and `~/Projects/hk` registered independently through Android. Official Codex 0.160.0; model/effort came from native model/list (GPT-6-Luna/low for this bounded test).
- Two native threads, four completed turns. Only `pwd` and the exact harmless `printf` approval commands were requested. Native command output matched each original cwd. Phone Allow and desktop Decline synchronized. Per-project lists, native history, completed receipts and forged-cwd checks passed on both clients.
- The **normal `bridge/src/main.ts` child process and official App Server were stopped and restarted**, using the same private state directory. Pairing, registry, remembered project/session, native completed history and receipts recovered. Each client then continued the other project's original native thread. Each thread had exactly two completed receipts.
- Project tree metadata/identities before and after the native run matched (excluding Oraculum's own caches/build/runtime artifacts); the global Codex configuration hash also matched. No user project file was moved or edited by the test. Android was awakened via ADB. Test processes stopped, ADB reverse restored, test credentials revoked, and the successful run restored Android browser storage/cookies captured at its start. The temporary CDP forward was removed.

Successful real evidence is private and excluded from Git:

`.local/evidence/projects/2026-10-22T07-42-27.319Z/acceptance.json`

The directory contains desktop/WebView screenshots and actual ADB device PNGs, including `electron-completed.png`, `android-folder-device.png`, `android-restarted-device.png`, `android-resumed-a-device.png`, and `electron-resumed-b.png`. Sanitized results and selected images are attached to the Task. Native test thread IDs:

- Oraculum: `01a1628f-de91-7be0-af7e-e77e50ce67ea`
- hk: `01a16290-5afa-7413-97ba-bc9708e00fd7`

Implementation commits: `e77dec9` (Bridge), `ec96265` (shared UI), `649e290` (first-registration writer-lock fix), each tested and normally pushed on main. The final evidence/script commit is recorded in the Task.

## Limits and review

- Scope is the two fixed host policy roots; expanding host access requires an explicit reviewed host-side change. Hidden folders and paths containing `%` or backslashes are intentionally not browsable. Missing roots are unavailable, not automatically created.
- Identity and realpath validation is an application boundary, not protection against a hostile local account racing filesystem changes between validation and the native process opening a path. Do not treat it as a replacement for Codex sandbox/approval.
- Pending native approval prompts are in-memory. This patch verifies pending approval synchronization while running and **completed** history/receipt recovery after restart; it does not claim to recreate pending approvals after App Server loss. The previously documented missing declined-command item in native persistent history remains a visible warning.
- No token statistics, MCP/Skills/plugins/web-search switches, Electron/Kotlin permissions, Phase 3B/Live UI redesign, VPS/SSH/Caddy/systemd or production deployment changes. No APK rebuild was needed: the unchanged installed debug WebView loaded the rebuilt shared UI. Android cellular/public-network acceptance and broader mobile UX are outside this Task.
- The real run used an isolated test state directory and temporary loopback Bridge, not the user's production registry or service. The test phone's prior cookie was replaced during the initial failed pairing run; later runs preserve their starting browser state. Existing production trust records were not altered. Re-pair the debug app against the intended normal Bridge when next used if its old session is unavailable.
- Roll back code with a normal reviewed revert of this patch's commits; do not delete the shared trust/receipt database. The additional projects table is additive and can remain unused by the previous code.

For a repeat of the real test, forward only the Oraculum debug WebView's CDP socket, ensure local port 17860 is free, and set `ORACULUM_ANDROID_CDP` to that loopback HTTP endpoint and `ORACULUM_EXISTING_PROJECTS` to a JSON array of two existing canonical directories under `~/Projects`. Run `pnpm exec tsx scripts/projects-live.ts`. The script performs real model turns; it must remain opt-in. Review the private evidence and the Notion Task before approving this patch or starting Phase 3B.
