# Runtime configuration and existing data

Phase 4A Patch 1 separates runtime configuration from the reviewed build schema.
This is a source/runtime contract, not an installer or permission to migrate data.
Phase 4B packaging and Phase 4C installation, backup and migration remain separate.

## Codex

- Runtime uses `codex` from the inherited `PATH`, or the absolute executable in
  `ORACULUM_CODEX_BIN`. No shell startup scripts or guessed user installation paths
  are injected. A missing binary produces an actionable error.
- The actual `--version` is diagnostic. Startup checks `initialize`, `config/read`,
  `model/list`, and `thread/list`; required response fields are checked when used.
  Additional fields and different version/model strings are accepted. Missing or
  incompatible APIs fail explicitly; uncertain operations are never auto-replayed.
- `CODEX_HOME`, native login/configuration, capabilities, approvals and sandbox
  settings remain inherited. Oraculum does not install or change the native CLI.
- `protocol.lock.json` still fixes the reviewed **build** schema. `pnpm protocol`
  can use a separately selected absolute `ORACULUM_CODEGEN_CODEX_BIN`; it validates
  staged output before replacing existing generated inputs. Normal `check`, `test`
  and Web `build` consume those inputs without requiring an exact runtime version.

## Paths

All `ORACULUM_*` path overrides must be absolute. Valid absolute XDG values are
honored; unset or relative XDG values fall back to the selected `HOME`. Paths must
be canonical; state/project/profile symlinks are not silently followed.

| Purpose | Default / explicit override |
| --- | --- |
| Program resources | Source/module-relative repository root; `ORACULUM_RESOURCE_DIR` selects an installed resource tree |
| Web files | `<resources>/apps/web/dist`, override `ORACULUM_WEB_DIR`; `index.html` must exist |
| Theme source | `<resources>/themes`, override `ORACULUM_THEME_SOURCE_DIR`; must exist at Bridge startup |
| Bridge state | `$XDG_STATE_HOME/oraculum` or `$HOME/.local/state/oraculum`; `ORACULUM_STATE_DIR` explicitly selects an existing store |
| Installed themes | `<selected-state>/themes`, override `ORACULUM_THEME_DIR`; existing themes stay beside their selected database |
| New default workspace | `$XDG_DATA_HOME/oraculum/workspaces/local` or `$HOME/.local/share/oraculum/workspaces/local` |
| Selected default project | `ORACULUM_WORKSPACE`; existing directories under `$HOME/Projects` or the managed workspace roots |
| Legacy workspace access | `$HOME/.cache/oraculum/workspaces` and `$XDG_CACHE_HOME/oraculum/workspaces` remain policy roots; no project is moved |
| Electron profile | `$XDG_CONFIG_HOME/oraculum` or `$HOME/.config/oraculum`; `ORACULUM_USER_DATA_DIR` explicitly selects a profile |
| Desktop icon | `<resources>/design/reference/02_Brand_OracleEye_App_Icon.png`, override `ORACULUM_DESKTOP_ICON` |

Resource trees may be supplied from any installation directory through the above
inputs. They do not depend on the process working directory. The eventual DEB must
supply its chosen layout and executable environment; no production Bridge bundle,
private Node installation, service, or installer is introduced by this patch.

## First start and existing state

A missing default store is an error, not permission to silently replace old data.
Choose the intended existing directory with `ORACULUM_STATE_DIR`. No legacy scan
selects a winner by date, size or directory name. If several candidate databases
exist, the operator must choose; the application does not merge or copy them.
Only a deliberate fresh installation may set `ORACULUM_INIT_STATE=1`; its target
must be absent or empty and private. This flag is not a migration switch.

Existing stores are inspected before startup writes. Foreign, corrupt, future or
unsupported schemas and conflicting permissions/paths fail explicitly. The same
selection rules apply to the host `trust` CLI. Invalid CLI commands fail before
opening state. Valid commands open the selected store and may perform its supported
schema upgrade; use them on real old stores only within an approved rollout.

When legacy workspaces exist, select `ORACULUM_WORKSPACE` explicitly. An existing
store without its expected default workspace also requires a selection. Startup
never creates a missing user project under `Projects`; managed default workspaces
may be created. Registration and symlink/hidden/dev+inode restrictions remain.

Electron refuses an implicit profile when an old `oraculum-phase0b` profile exists
under HOME or XDG, or when no current profile exists. Explicitly select the existing
profile to keep it in place, or explicitly name a fresh profile. After read-only
preflight, missing components of an explicitly selected path are created privately
(0700) before `app.setPath`; ownership, permissions, writability and the full
non-symlink chain are checked again. Creation errors stop startup without chmod,
copy or cleanup of existing data; any already-created private parent directories
are retained rather than risking deletion of concurrent data. No profile data,
Cookie, draft, preference or native Codex directory is copied or cleared.

`pnpm exec tsx scripts/desktop-profile-contract.ts` runs real Electron first-start,
restart, explicit legacy-profile reuse and refusal regressions against a temporary
authenticated Bridge with simulated Codex. It uses disposable HOME/XDG/profile
fixtures, verifies persisted layout and pairing, and leaves real user data alone.
It requires a built Web UI and a graphical session with a working OS sandbox.
On an automation host without a usable sandbox, the explicit test-only
`ORACULUM_PROFILE_TEST_NO_SANDBOX=1` opt-in runs the storage/path checks but reports
that OS sandbox operation was **not** tested; product security settings are unchanged.

Path/config preflight failures perform no state/workspace creation. Failed Codex
initialization removes only newly-created empty workspace directories and does not
open the trust store. A later failure, such as a port becoming occupied, closes its
child and database but preserves initialized state **and** its registered workspace
for recovery. It does not destructively undo database upgrades or delete new data.

## Device trust and rollback

New device records have no server expiry (`expires_at IS NULL`); revoke/logout
ends authorization. Schema v1 transactionally upgrades only still-valid,
non-revoked v0 devices. Expired/revoked legacy records never become permanent, even
if the host clock later moves backward. Other tables and receipt data are retained.

The browser gets a 365-day HttpOnly, SameSite=Strict cookie (Secure for HTTPS,
scoped to the configured Base Path). Valid session checks renew it; the visible UI
checks daily and on returning to the foreground. Origin/path checks, duplicate
cookie rejection, WebSocket authorization and per-device revocation remain active.
Cleared storage, different profiles/entries, lost tokens, or browser expiry after
long inactivity can still require pairing. An already-expired old cookie cannot
be remotely renewed; valid old cookies need a successful visit before expiry.

Source commits can be reverted normally. Schema v1 uses nullable device expiry,
so an older Bridge does not understand the new authorizations. A future real rollout
must back up the selected database first and plan compatible rollback or forward
repair; never restore an old copy over newly-written receipts. This patch's tests
upgrade only isolated fixtures and do not migrate actual user state.
