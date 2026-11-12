# Release build and verification

Bridge/Desktop now use the independent [component candidate workflow](COMPONENT_RELEASES.md)
and [phase B installation handoff](PHASE_B_SPLIT_PACKAGES.md). Their versions come
from `release.json.components`; Desktop no longer embeds Bridge or server Node.
The bundled runtime instructions below describe the historical 0.1.x release.
The Android section uses the top-level version/code.

## Oraculum 2.0 Beta 1

The [Beta release task](https://app.notion.com/p/4165421e690b81d89265e1d138ab1719)
authorizes one GitHub Pre-release named `Oraculum 2.0.0 Beta 1`, tagged
`v2.0.0-beta.1`. Build Gateway `2.0.0~beta.1` amd64 and Android
`2.0.0-beta.1` / code `5` from the same clean committed `main` SHA.
Bridge/Desktop component versions remain unchanged and are not built.

Gateway advertises the Debian version from its package metadata in capabilities
and the Codex handshake; its private npm workspace uses `2.0.0-beta.1` SemVer.
The APK verifier checks the current Compose client's exact three platform
permissions plus AndroidX's signature-only dynamic receiver permission, private
artifact/startup providers and Room service, and DUMP-protected profile receiver.
It does not require the removed legacy WebView foreground service.

Gateway metadata uses `releaseChannel: beta`, `candidate: false`: a distributable
pre-release rather than an unpublished development candidate. This is not a Stable
declaration or proof of publication. See [Gateway verification](../gateway/README.md).
Run `pnpm check`, Gateway/protocol tests, `pnpm verify:gateway:protocol`, isolated
fault/live checks, `pnpm build:gateway:deb` and the actual DEB verifier. Its dpkg,
initialization and pairing checks operate only on disposable fixtures.

For Android, preserve earlier build outputs, then run
`bash scripts/android-release-build.sh --unsigned` and the existing
`python3 scripts/android-signing.py release --auto --apk <reviewed-unsigned.apk>`.
Both source gates exclude only the user's untracked Stitch originals; tracked
changes and all other untracked source remain blocking. Keep all original
signing identity, ownership, backup-attestation, certificate and integrity checks.

After both artifacts pass, publish the immutable tag at their common source SHA
and a GitHub release with `prerelease=true` and Latest disabled. Attach the DEB,
signed APK, `gateway-release.json`, `android-release.json`, `SHA256SUMS` and
`RELEASE_NOTES.md`. Manifests record full source SHA, clean status, version,
size/hash, protocol/schema or APK identity/certificate. Verify downloaded assets,
tag provenance and pre-release status after publication. Record evidence in the
task and keep it In progress for user acceptance. No production install,
initialization, pairing, service or network changes are authorized by this release.

Phase 4 authorization and product decisions remain in the Notion Project/Task.
Building does not authorize installation, service registration/start, migration,
Android replacement, or changes to other services.

The current R1-B8 `0.1.2` artifact identity, regression evidence, crash investigation,
original signing command and upgrade guide are in [the release handoff](R1_B8_RELEASE.md).
The automatic signing workflow below supersedes its historical manual-only policy.

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
the caller to the signing launcher. Neither entry installs or
uninstalls anything, and no Release path falls back to Debug signing.

For unattended signing, including a captured agent session without a TTY:

```sh
cd ~/Projects/Oraculum
python3 scripts/android-signing.py release --auto
```

Automatic mode reads the existing Ubuntu Secret Service items with
`secret-tool lookup app oraculum type jks-store` and
`secret-tool lookup app oraculum type jks-key`. Run in the user's login session
with `secret-tool` installed and the existing keyring available and unlocked.
The launcher does not provision credentials or change the keyring/JKS/backup.
Missing, empty, multiline or unreadable credentials stop signing; there is no
fallback to a password prompt. Lookup and signing have bounded timeouts.

Passwords stay in process memory and an anonymous stdin pipe to official
`apksigner` using `--ks-pass stdin --key-pass stdin`, store password first, key
password second. They never enter command arguments, environment variables,
Gradle, logs or plaintext files. Secret lookup diagnostics and automatic signer
stdout/stderr are discarded, including on failure. The public verifier reports
contain artifact hashes, build identity and certificate fingerprints only.
See the official [apksigner stdin format](https://developer.android.com/tools/apksigner)
and [secret-tool implementation](https://github.com/GNOME/libsecret/blob/main/tool/secret-tool.c).

The user's instruction to “签名 APK” or “构建并发布 APK” authorizes the requested
signing/release work. Agents should use `release --auto`, calculate/verify public
hashes themselves, and proceed without password/hash questions, extra
confirmation, one-time authorization codes or manual approval gates. Failures
must preserve existing artifacts and report the concrete error. Installation,
state migration and production service changes retain their separate scope.

Interactive signing remains available with `python3 scripts/android-signing.py release`
in the user's real local terminal, with recording and shell tracing disabled.
This mode keeps direct, non-echoing console input in apksigner and requires a TTY.

For an existing reviewed unsigned APK, avoid rebuilding it by passing
`--apk /absolute/path/to/oraculum-<version>-<code>-unsigned.apk` to `release`.
The launcher verifies a private copy, requires clean embedded build identity and
a known source commit, signs using the existing primary JKS, pins the resulting
certificate to the saved public SHA-256 and publishes only after verification.
It preserves both the input and any existing signed output. The selected version
must match `release.json`; the `--apk` path deliberately identifies the reviewed
build even if later documentation commits moved HEAD. Verify its public SHA-256
against the build evidence automatically; no user-entered hash or confirmation
is required. Both interactive and automatic modes support `--apk`.

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
SDK 35 `apksigner` signs it in a separate process, reading passwords from the
user's real terminal or the automatic stdin pipe described above. No password
enters command arguments, environment variables, Gradle properties, caches or reports. Fixed
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

Inspect the actual installed APK certificate before attempting an update. A
different certificate cannot qualify as a normal same-ID update; versionName or
the debuggable flag alone does not establish compatibility. Device installation,
actual upgrade and private WebView state migration remain user acceptance work.
