# Oraculum Desktop changelog

## 0.2.0 — review candidate

- Keeps the existing `oraculum` Debian package identity while removing the bundled Bridge and its private Node runtime.
- Packages desktop splash, icon and notification resources independently from Bridge assets.
- Reads the existing external runtime configuration and connects to the independently installed Bridge, preserving the desktop profile.
- Provides an actionable missing or incompatible Bridge message and retains the existing policy for starting an already registered user service.
- Uses its own version and build provenance; Bridge-only updates no longer require a Desktop rebuild.

This is a phase B candidate for independent review. Upgrade production Desktop only after the separately approved Bridge installation and controlled service-entry switch.
