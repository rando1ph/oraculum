# Oraculum Desktop 2.0.0 Beta 1

This is the first independent Ubuntu Desktop Pre-release. It contains the
accepted three-column Desktop, Light / Dark / OLED Dark themes, Gateway pairing,
offline reading of previously loaded conversations, local drafts and recovery
using the original operation receipts.

- **Target** Ubuntu 24.04 LTS (amd64)
- **Package** `oraculum-desktop` `2.0.0~beta.1`
- **Source** [`@SOURCE_GIT@`](https://github.com/rando1ph/oraculum/commit/@SOURCE_GIT@)
- **License** Apache-2.0 for Oraculum code, with Electron, Chromium, bundled
  library notices and the existing Oracle Eye brand rights documented in the DEB
- **Runtime** Chromium sandbox, a separate production profile and a Secret
  Service keyring for protected pairing credentials

Download the DEB and `SHA256SUMS` to verify the package. Ubuntu's package manager
installs the DEB. Launch **神谕 · Oraculum Desktop** from the application menu.
This client connects to an existing Oraculum Gateway using protocol 2.1. The
Gateway and Codex App Server are distributed separately.

The Beta interface is in Simplified Chinese. English localization and the
planned visual refinement are future work. Pair this Desktop as a new device.
The Beta does not migrate the retired Desktop's data. Installing and removing
the package leaves the user's Desktop profile in place.

[Build, installation and removal guide](https://github.com/rando1ph/oraculum/blob/@SOURCE_GIT@/apps/desktop/README.md)
