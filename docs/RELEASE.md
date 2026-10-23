# Release build and verification

Phase 4 authorization and product decisions remain in the Notion Project/Task.
Building does not authorize installation, service registration/start, migration,
Android replacement, or changes to other services.

## Production runtime

`pnpm build:runtime` builds the Web UI and a standalone Linux amd64 tree under
`dist/runtime`. It contains compiled Bridge/trust entry points, locked production
dependencies, the official Node 24.21.0 runtime verified against its pinned
SHA-256, Node's license, package licenses, Web assets, themes and Oracle Eye assets.
No tsx, pnpm, repository cwd, npm or second Codex installation is required at run
time. The installed runtime belongs at `/usr/lib/oraculum/resources/runtime`.

`bin/oraculum-bridge` starts the Bridge; `bin/oraculum-bridge trust pair|list|revoke`
manages its trust store. The official user's Codex remains external. Its executable
is discovered from the inherited PATH plus `$HOME/.local/bin`, or an explicitly
selected absolute `ORACULUM_CODEX_BIN`. `CODEX_HOME` and native configuration stay
unchanged. The same private Node runs both commands.

The desktop and Bridge read `$XDG_CONFIG_HOME/oraculum/runtime.json` (default
`~/.config/oraculum/runtime.json`), or `ORACULUM_CONFIG_FILE`. This is JSON, never
shell code, with user ownership and mode 0600. Environment values take precedence.
Allowed settings are listed in `packaging/runtime-config.cjs`; example shape:

```json
{
  "ORACULUM_STATE_DIR": "/absolute/selected/existing/state",
  "ORACULUM_WORKSPACE": "/absolute/selected/existing/project",
  "ORACULUM_USER_DATA_DIR": "/absolute/selected/desktop/profile"
}
```

Do not populate these from guessed historical directories. Phase 4C must select
and back up real state before writing configuration. Fresh isolated verification
uses explicit temporary HOME/XDG/profile paths and `ORACULUM_INIT_STATE=1` only
in its environment; that fresh-store override is deliberately not persisted in
runtime.json. The prior path/schema/permissions checks remain active.

`oraculum-bridge.service` is shipped as a resource, not registered by package
scripts. Its future approved registration/start is separate from installation.
The GUI can start an already registered user unit and waits for actual health;
it never stops the unit when the window closes. No automatic enable or linger
change is performed. The unit restarts only after failure, with three attempts
per minute and a finite shutdown timeout. Unexpected native Codex failure makes
the Bridge unavailable and exits nonzero; no operation is replayed automatically.

## Verification boundaries and rollback

Tests with a fake CLI prove lifecycle and protocol contracts, not actual model
execution. Extracted-package validation is not an installed DEB or Android device
upgrade test. OS sandbox requires an actual sandboxed Electron launch and renderer
evidence; neither `sandbox:true` nor a `--no-sandbox` test constitutes acceptance.

Before Phase 4C, rollback is limited to stopping isolated test processes and
rebuilding an earlier Git revision's artifacts. No production state is changed.
For approved installation, retain the previous DEB/APK, select and back up state
first, and preserve any new receipts before reverting software; never replace a
live database with an old snapshot or replay unknown operations. Android updates
require the same certificate and a higher versionCode. Debug-to-Release cannot be
treated as a normal update, and uninstalling cannot restore lost private state.

## Brand validation

The default Web empty state uses the eight approved Brand Copy v0.2 strings.
The just-created Thread marker is memory-only; refreshing or reopening uses the
existing-empty-Thread copy. Native errors, approvals and active turns take
precedence. The 16,000-character text limit is unchanged.

Electron loads its packaged local splash and hands off as soon as the main page
loads, with local retry/exit recovery when Bridge is unavailable. Android uses a
black native launch theme plus a local Canvas overlay, with a native server settings
button; trusted page completion or failure preempts the animation. Both retain the
approved original mark, declarations and reduced-motion alternative. Neither
splash sends native model requests or depends on trusted-theme CSS.

`pnpm exec tsx scripts/brand-web-contract.ts` checks the Web states and responsive
layouts with simulated protocol data. `scripts/brand-desktop-contract.ts` checks
real Electron local rendering, handoff and recovery; its explicit test-only
`ORACULUM_BRAND_TEST_NO_SANDBOX=1` option does not prove OS sandbox. Android native
visual/touch and installed-package/device upgrade acceptance remain separate.
