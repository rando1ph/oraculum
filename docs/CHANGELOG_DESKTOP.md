# Oraculum Desktop changelog

> Historical record — retired Bridge/Web UI/Desktop architecture. P4.3.5 removes its runtime and exclusive build/test/release tooling. Commands and source links below describe their original Git revision; do not use them as current instructions. See the [documentation index](README.md) for active Oraculum 2.0 guides.

## 0.2.0 — review candidate

- Keeps the existing `oraculum` Debian package identity while removing the bundled Bridge and its private Node runtime.
- Packages desktop splash, icon and notification resources independently from Bridge assets.
- Reads the existing external runtime configuration and connects to the independently installed Bridge, preserving the desktop profile.
- Provides an actionable missing or incompatible Bridge message and retains the existing policy for starting an already registered user service.
- Uses its own version and build provenance; Bridge-only updates no longer require a Desktop rebuild.

This is a phase B candidate for independent review. Upgrade production Desktop only after the separately approved Bridge installation and controlled service-entry switch.
