# R1-B7 — Native notifications and recovery

Canonical task: https://app.notion.com/p/4085421e690b81eda79ad442c3bb5732

## Implementation

`BridgeService` projects owned native `turn/completed` facts and its existing pending requests into a disposable notification feed. Completed/failed root turns notify; child completion noise and retrying errors do not. Child requests locate the parent conversation. At most one reminder per conversation is exposed, bounded to 64 conversations. Native request tokens deduplicate requests, and a bounded terminal-turn set deduplicates completion events. A new turn, lifecycle change, request resolution, expiry or App Server failure removes obsolete reminders. Terminal results expire after five minutes; pending reminders have a renewable 15-second lease.

The authenticated `/notifications` endpoint requires the configured Origin and a dedicated header, has `no-store` responses, and rechecks device authorization after asynchronous directory validation. Root and configured HTTPS Base Path use the existing trust boundary. Only event kind, opaque ID, timestamps and authenticated routing metadata leave the projection. Conversation text, commands, filenames, errors and approval responses are absent. A read-only `bridge/notifications` RPC resolves clicks against the current feed.

Electron's main process polls the feed with its existing Chromium session every two seconds and owns `Notification` objects. Renderer permissions, sandbox and context isolation stay in force; there is no preload or renderer-to-OS API. OS copy is fixed. Seen IDs are bounded and persisted in the private Electron profile; removed/expired reminders close, and connection failure clears reminders. A native click restores the window and passes only a notice ID to React, which rechecks the feed and uses normal project selection/subscription. It never approves or resends an operation.

Android uses an unexported `remoteMessaging` foreground service for cross-device conversation continuity, with a low-importance persistent connection notification and a separate task channel. Its bounded HTTP polling runs independently of WebView/background JavaScript. The currently trusted WebView profile supplies only the applicable device cookie to this private service in memory; credentials are not persisted by the service, exposed to JS, logged or redirected to another server. TLS verification and entry/profile isolation remain intact. A denied/disabled task channel prevents the service starting; settings include a gesture-checked system notification settings link. Ordinary polls do not repost notifications; active reminders renew silently at most once per ten seconds, expire without a fresh feed and respect user dismissal. Native immutable PendingIntents carry only a notice ID and entry identity.

The shared UI retries connections with 1–30 second backoff, probes a silent connection every 20 seconds with a five-second deadline, and reconciles native state after focus, network return and Android resume. An existing project/session keeps drafts, reading state, pending forms and inspector state while it can still be read. A removed/archived session falls back through the normal project list and retains its saved draft. Native-shell drafts survive window recreation; browser tabs remain independent. An already-paired connection gate also retries after an outage. Sends, approvals and other mutations are never automatically replayed; existing unknown-operation receipts remain authoritative.

## Safe Debug verification

Debug builds now use `dev.oraculum.poc.debug` and the label `神谕 Debug`; release identity and signing are unchanged. `oraculumDebugPort` is a build input (default `17860`), allowing a completely separate loopback test Bridge. No production Bridge, tunnel, VPS, installed package or release keystore needs modification.

```bash
pnpm check
pnpm test
pnpm build
bash scripts/android-build.sh -PoraculumDebugPort=17907 :app:testDebugUnitTest
adb install -r apps/android/app/build/outputs/apk/debug/app-debug.apk
ORACULUM_GNOME_CAPTURE="$PWD/scripts/gnome-screenshot.py" pnpm test:notifications:devices
pnpm test:notifications:native
```

The device harness uses only the dedicated Debug package, authenticated temporary state and port 17907. It restores ADB mappings and stops its own Debug process during cleanup without clearing data or uninstalling anything. The GNOME helper requires the user's existing `/dev/uinput` access and an unlocked desktop; it uses normal desktop/screenshot shortcuts and changes no settings. Screenshots come directly from GNOME and ADB, without generated or composited notification UI. To avoid exposing unrelated notification-center content, Ubuntu captures use native banners. For a repeat run without desktop capture, use `ORACULUM_SKIP_SCREENSHOTS=1 pnpm test:notifications:devices`; Android notification-shade interaction is still exercised.

## Evidence and limits

Verified on real Ubuntu Electron and HONOR Android 15: foreground completion notice; a new failed-event notification after Home and a background interval; all four event kinds; duplicate suppression; cross-device approval resolution; stale notice rejection; actual Android notification-shade tap routing from another selected session; draft/reading recovery; automatic fresh native reads after socket termination and an HTTP 503 interval; and fallback when the selected conversation disappears while disconnected. Notification scenarios deliberately use controlled native-protocol fixtures. A separate official Codex turn, inheriting existing model/effort configuration and using no tools, verifies real native completion to redacted feed; its configuration hash remains unchanged.

This batch verifies foreground and Home/background operation with a living process. It does not claim lock-screen, Doze, process-death, long-sleep, release APK, DEB, public-network deployment or B8 acceptance. The service uses a visible connection indicator and short polling rather than a push account. A disconnected client may hide a reminder and will not repeatedly alert for the same previously seen ID after reconnection; the normal session query restores authoritative pending actions. Feed completion state is intentionally ephemeral across Bridge restart. Unsaved attachment bytes and sensitive native-answer form contents are not newly persisted to disk.

Task remains **In progress** for user visual acceptance and independent source review. Final screenshots and commit/push evidence are recorded in the Task and the user-designated private Drive folder.

## Official references

- [Electron native notifications](https://www.electronjs.org/docs/latest/api/notification)
- [Electron session.fetch](https://www.electronjs.org/docs/latest/api/session#sesfetchinput-init)
- [Android notification permissions and channels](https://developer.android.com/develop/ui/views/notifications/build-notification)
- [Android remoteMessaging foreground service type](https://developer.android.com/develop/background-work/services/fgs/service-types#remote-messaging)
