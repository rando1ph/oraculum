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

## Ubuntu DEB

`pnpm build:deb` uses locked Electron Forge/maker-deb 8.0.1 and Electron 44.9.1.
The single version source is `release.json`. Only the desktop shell is staged;
its build configuration is removed from the installed application. The Bridge
runtime is copied as `resources/runtime`. Forge's normal Debian sandbox helper
handling records root ownership and mode 4755 in the package; no host helper is
changed. The package declares native GUI libraries and Chinese fonts.

The artifact is `dist/desktop/out/make/deb/x64/oraculum_<version>_amd64.deb`.
`node scripts/verify-deb.mjs <artifact>` inspects and extracts without installing.
`node scripts/package-sandbox-check.mjs <artifact>` launches the extracted actual
Electron executable against an isolated HTTP fixture, without a sandbox override.
It requires renderer seccomp, no-new-privileges and separate namespaces; exit 2
records a verification block. Inspect the captured error to distinguish host
restrictions from package defects. Root:root 4755 metadata inside a DEB alone cannot
prove an extracted or installed process has a working OS sandbox. Never change
host ownership, AppArmor or kernel policy to make this build check pass.

If an already installed root:root 4755 helper is byte-identical, the optional
`--sandbox-helper /absolute/path/to/chrome-sandbox` check can reference it from
the disposable extraction. It checks the bytes and permissions first and changes
only a temporary symlink. No installation or host file change occurs. Kernel
`NSpid` nesting supplies PID namespace evidence when non-dumpable sandbox processes
deny `/proc` namespace readlinks; seccomp, NoNewPrivs and zero capabilities remain
mandatory. This result is conditional on the existing helper, not an install test.

Run GUI contracts on a private display, not the active desktop:

```sh
bash scripts/isolated-ui.sh pnpm test:artifacts:ui
bash scripts/isolated-ui.sh node scripts/package-sandbox-check.mjs <deb> --sandbox-helper <existing-identical-root-helper>
bash scripts/isolated-ui.sh node scripts/package-ui-contract.mjs <deb> --sandbox-helper <existing-identical-root-helper>
```

The wrapper requires Xvfb/xvfb-run (system installation or a local extraction at
`.local/test-display/root/usr/bin`; `ORACULUM_XVFB_BIN` selects another extraction),
`xauth`, `dbus-run-session` and a systemd user session. It has no desktop fallback.
It uses software rendering, private Xauthority/D-Bus without service activation,
and a disposable scope capped at two CPUs and 6 GiB memory. Run heavy builds and
GUI suites sequentially. Source Electron contracts use Playwright's existing
sandbox defaults and do not prove the OS sandbox. Packaged contracts explicitly
request it and reuse authenticated attachment/artifact/extension fixtures against
the actual release Electron, Web and themes. Their native RPC replies and Bridge
service are controlled fixtures; compiled standalone Bridge validation is separate.

`ORACULUM_TEST_CODEX_BIN=/absolute/official/codex node scripts/runtime-contract.mjs`
uses the actual installed official CLI with a disposable CODEX_HOME, only for
read-only initialization. This does not verify the user's full native config or
compatibility with an uninstalled future Codex version.

Build once for tests, commit the verified source, then rebuild on a clean tree so
`resources/runtime/build.json` records the actual source Git SHA. Preserve artifact
hashes outside Git. DEB direct local installation needs no GPG repository signing.

## Android Release and local key custody

`release.json` also defines Android `versionName` and `versionCode`. Keep the
application ID `dev.oraculum.poc` and increment the code for each published update.
`bash scripts/android-release-build.sh --unsigned` runs Release compilation,
lint and unit tests without a key. Its unsigned output is only a preflight result,
never a signed release. The no-argument build entry refuses to run and directs
the user to the local interactive signing launcher. Neither entry installs or
uninstalls anything, and no Release path falls back to Debug signing.

Only the user runs these commands in their own local terminal with recording and
shell tracing disabled; never use a captured agent terminal for them:

```sh
cd ~/Projects/Oraculum
python3 scripts/android-signing.py release
```

For an existing reviewed unsigned APK, avoid rebuilding it by passing
`--apk /absolute/path/to/oraculum-<version>-<code>-unsigned.apk` to `release`.
The launcher verifies a private copy, requires clean embedded build identity and
a known source commit, signs using the existing primary JKS, pins the resulting
certificate to the saved public SHA-256 and publishes only after verification.
It preserves both the input and any existing signed output. The selected version
must match `release.json`; the `--apk` path deliberately identifies the reviewed
build even if later documentation commits moved HEAD. Check its published SHA-256
before running this command. No signing password enters the launcher or Gradle.

Daily signing does **not** access the offline backup. It retains the original
`backupVerified` attestation and checks primary key/configuration ownership,
permissions and path safety. To explicitly compare the original backup later,
attach its media and run `python3 scripts/android-signing.py verify-backup`.
This read-only comparison changes neither key nor configuration and asks for no
password. It does not replace the initial private-key/certificate verification.

Only for first-time key setup, `python3 scripts/android-signing.py init` creates
a dedicated JKS (RSA 3072, alias `oraculum-release`) in
`~/.local/share/oraculum-signing`, with directory/file permissions 0700/0600.
It refuses any existing key, including dangling links. Supply an absolute private
backup directory on media you control and can keep offline; a cloud-synced folder
is unsuitable. It copies without overwriting, verifies both private keys can
unlock/sign and have the same certificate, and asks you to confirm offline
custody. This confirmation is a user attestation; software cannot prove how media
will be stored. The verified backup can then remain offline during daily signing.
Only paths, alias, backup-verification status and public certificate SHA-256 enter
the external `release-signing.json`; no passwords are saved.

If creation was interrupted after the key appeared, use
`python3 scripts/android-signing.py resume`. This verifies the existing key and
completes its backup/configuration without generating or overwriting a key.
If a partial or different backup already exists, preserve it and choose a fresh
private backup directory. Existing configuration is never replaced automatically.

The release command requires a clean committed tree. Without `--apk`, Gradle builds and verifies
an aligned unsigned APK with no signing configuration or password inputs, then
SDK 35 `apksigner` signs it in a separate process, reading passwords directly from
the user's real terminal without echo. No password enters Python, command
arguments, environment variables, Gradle properties, caches or reports. Fixed
Gradle flags disable configuration/build caches, scans and persistent Kotlin
daemons; the wrapper accepts no arbitrary logging flags.

This deliberately refines the earlier Notion `signingConfigs.release` detail:
inspection of AGP 8.13.2 showed `SigningConfigData` exposes unsalted password
hashes as nested task `@Input` values, which Gradle 8.13 persists in execution
history even with build/configuration caches off. Separate official `apksigner`
signing satisfies the user's stronger requirement not to record signing secrets
or password-derived verification values. No real password was supplied to
Gradle during investigation. Product architecture and the fixed toolchain stay
the same; the implementation adjustment is recorded for independent review.

The final signed artifact is `dist/android/oraculum-<version>-<code>.apk`, published
atomically after verification. It includes source Git metadata. The verifier uses
SDK 35 `apksigner verify --verbose --print-certs`, `zipalign` and `aapt2` to check
signature/certificate continuity, version, identity, manifest safety and original
brand resources. Public reports live under `.local/evidence/phase4b/android`.
An existing same-version artifact is verified and preserved; different source
requires a version increment. See [Android signing](https://developer.android.com/studio/publish/app-signing)
and [apksigner](https://developer.android.com/tools/apksigner).

This dedicated release certificate cannot replace the existing Debug install as
a normal same-ID update. Device installation, Debug removal, actual upgrade and
private WebView state migration remain Phase 4C work with separate authorization.
