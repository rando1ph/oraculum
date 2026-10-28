# R1-B5-B host artifacts

Read-only output access is separate from B5-A input. Input IDs and historical
attachment cards confer no download permission. Agent text/links are never used
to authorize a host path. No project files are written by this feature.

## HTTP and scope

`POST <entry-base>artifacts/list` takes `{cwd, threadId, path?, cursor?}`;
`POST <entry-base>artifacts/select` takes `{cwd, threadId, path}`. Paths are strict
project-relative names. The user browses actual directory entries and explicitly
selects an output. A loaded, tracked, non-archived native thread must belong to the
registered canonical project. Existing Bridge trust governs project access; it
does not introduce a different per-device project ACL.

Selection returns verified metadata and a random output ID, bound to device,
project, thread, directory identities and file version for five minutes. Grants
live in bounded Bridge memory; restart requires a new selection. They contain no
file bytes and are not bearer tokens. `POST <entry-base>artifacts/content/<id>`
authenticates again and revalidates that scope/version before and during reading.
All three routes require the existing scoped HttpOnly cookie, exact Origin and
`X-Oraculum-Artifact: 1`. Queries and ranges are rejected. GET cannot download.
Local root and configured HTTPS/Base Path entries retain separate cookie scopes.

## Filesystem and content

Every directory is opened with `O_DIRECTORY|O_NOFOLLOW`, starting at `/`, and child
reads use Linux `/proc/self/fd` descriptor-relative paths. The project inode must
match its existing registration. Ancestors are rechecked against canonical paths
and saved inodes. Separately registered nested projects cannot be traversed.
File opens use `O_NOFOLLOW|O_NONBLOCK`, accept only regular single-link files and
bind device/inode/size/nanosecond modification and change times. Directory swaps,
symlinks, hardlinks, special files, traversal, encoded separators and stale grants
fail closed. Each transfer checks content type, hashes the complete selected
version, and rechecks identity during reads and before its final chunk. The
`X-Oraculum-SHA256` response permits client integrity checks.

All dot paths (including `.git`, `.env`, `.oraculum-attachments`), credential,
secret, auth, token, password, key and configuration names are excluded, as are
dependency folders. Unknown formats, HTML, SVG and executables are denied. The
allowlist is PNG/JPEG/WebP, UTF-8 TXT/Markdown/CSV, PDF and DOCX/XLSX/PPTX, using
B5-A's bounded signature/Office-container validation without changing its upload
contract. Names and extensions alone do not establish type. This is not a secret
content classifier: users must avoid placing private data in normal output files.
Files controlled by an administrator or another process with the same Unix UID
are not a separate host-user security boundary.

Responses force attachment disposition with an encoded display filename, fixed
MIME, `nosniff` and `no-store, no-transform`. Explicit identity encoding preserves
the original length and digest through HTTP proxies. Errors contain neither host paths nor raw OS stacks.
Binary bytes never travel through WebSocket; ordinary JSON/WS remain 64 KiB.

## Limits

- 64 MiB/file; empty UTF-8 text is allowed. Oversized files are omitted/refused.
- 80 entries/page, at most 4,000 directory entries examined/request; a visibly
  limited result asks the user to use a smaller directory. No recursive scan.
- 256 grants globally, 48/device, five-minute lifetime.
- 60 requests/device/minute, 180 globally; four metadata requests globally,
  one/device. Two downloads globally, one/device.
- 180-second total, 15-second idle deadline; auth/cancel checks every chunk and
  every 250 ms while idle; stream backpressure and 64 KiB read buffers.
- Preview ceilings: text 512 KiB, images 8 MiB, PDF 16 MiB. Larger supported files
  remain downloadable. No resumable ranges in this version.

## Inspector and previews

The existing Inspector gains a File tab, and the mobile session menu gains Project
Artifacts. Real directory entries have name/type/size cards, bounded paging,
refresh, safe preview and download actions. Selection focuses and scrolls the
preview into view. Closing/switching the panel, project or thread releases object
URLs, aborts pending requests and discards client references to output grants. A disconnected
or unsynchronized project cannot keep displaying a previous preview.

The Web client fetches with same-origin credentials and no redirects, displays
progress/cancel, checks declared length/MIME and SHA-256 before handing a Blob to
the system. Desktop/browser memory is bounded by the 64 MiB download ceiling;
Blob/digest copies can consume more than one file's worth of memory. Mobile's
native download path streams into private cache instead. TXT/CSV are escaped
text; Markdown reuses the existing safe GFM renderer (no raw HTML, navigable
links or remote images). Images use only validated PNG/JPEG/WebP blobs.

PDF.js 6.4.299 and its same-origin worker are lazy-loaded only for PDF previews.
Only canvas pages are rendered: no viewer, annotations/forms HTML, JavaScript
manager, external document URL, attachment extraction, font-face injection, WASM
or remote resource fetch. Page/image pixels are bounded and a 12-second loading
or rendering deadline destroys the worker. Unsupported fonts/image formats,
encrypted or malformed documents can fall back to system download/open. The CSP
is unchanged. The Web notice collector includes PDF.js's Apache-2.0 license and
excludes its unbundled optional Node native canvas backend.

Electron accepts only bounded same-origin Blob downloads with safe names and a
matching allowlisted MIME. The system save dialog chooses the destination. A
completed save offers explicit external open; `shell.openPath` only receives that
completed user-selected path. No renderer Node/IPC or arbitrary URL opener.

## Android save/share

A trusted main-frame, nonredirected user gesture may invoke only
`oraculum://artifact/{save|share|open}/<output-uuid>`. No cwd, path, cookie or bearer
token appears in this URI. The shell snapshots the active WebView profile's one
expected application cookie on the UI thread for its internal authenticated POST;
it never sends that cookie through an Intent or copies another profile's cookies.
TLS verification stays standard, redirects are disabled and response MIME, encoded
filename, length and digest are checked again. A single native operation streams
to a generated private cache directory with progress/cancel, 15-second connection/
read and 180-second transfer limits. Navigation/entry changes/destruction cancel
the operation and invalidate its eventual activity result. Upload and save pickers
cannot overlap or consume each other's result.

Save uses `ACTION_CREATE_DOCUMENT`/`CATEGORY_OPENABLE` and the user's temporary
write grant. It copies verified bytes via a cancelable content descriptor, reports
progress and attempts to remove only this just-created document after failure.
The outstanding SAF result pairing remains blocked after cancellation until the
result returns. Share/open uses the existing AndroidX FileProvider, an unexported
provider scoped only to `cache/artifact-shares/`, plus `ClipData` and temporary
read-only URI grants. There is no broad storage/media permission, persistent URI
grant, DownloadManager, JS interface, file/content WebView access or background
service. Cache cleanup keeps at most four previous entries before creating the
next output; entries older than 24 hours are removed at the next operation or
initialization. There is no background expiry service. At most five entries and
320 MiB include the active/most recently completed transfer, with free-space
checks. Unfinished files are removed
on handled failure; process death can leave a private cache entry until cleanup.

## Verification and remaining Release acceptance

Use isolated projects and synthetic fixtures only. `bridge/src/artifacts.test.ts`
checks real authenticated HTTP responses, scope/type/path restrictions, stale
versions, replacement races, revoke/abort/timeouts and resource cleanup. Native
SAF/provider/reader behavior on a signed Android Release remains B8 acceptance;
Kotlin/JVM checks and Chromium touch simulation do not replace it.

- `pnpm check`, `pnpm test`, `pnpm build`, `pnpm test:artifacts:ui`.
- `apps/web/src/artifact-client.test.ts`: authenticated Base Path, byte length,
  integrity, MIME, revoke, interruption, oversize and abort behavior.
- `bridge/src/desktop-artifacts.test.ts`: Blob origin/name/MIME/size enforcement.
- Android `:app:compileDebugKotlin :app:testDebugUnitTest :app:lintDebug`; no assemble,
  package, sign, installation or ADB. Pure JVM tests exercise route/cookie isolation,
  filename/type/length policy, complete/empty/truncated/canceled/digest copies.
- UI fixture runs actual Electron and HTTPS/subpath Chromium touch downloads for
  synthetic PDF/PPTX/XLSX/PNG/CSV, four themes, GFM/text/PDF previews, cancellation,
  renamed-file errors, scope switching, narrow/landscape/keyboard-height geometry,
  Android action links/Back and mid-response trust revocation. Electron save/open
  dialogs are stubbed to an isolated destination; no external reader is launched.
  Office fixtures verify container validation and exact byte delivery, not a
  desktop Office application's interpretation.
- B8 on the signed Release still needs SAF providers (local/cloud), picker cancel/
  Back/reselection, actual PDF/Office readers and share targets, URI grant lifetime,
  zero/large files, low storage, weak/offline networks, entry/profile isolation,
  revoke during save/download, app rotation/background/process death, and the
  B5-A mobile input → native Codex → B5-B output round trip. Real DEB save/open and
  installed Electron OS sandbox also remain package acceptance. No production
  data, credentials, Codex configuration/CLI or network services are changed here.

API references: [Android SAF](https://developer.android.com/training/data-storage/shared/documents-files),
[Android FileProvider](https://developer.android.com/reference/androidx/core/content/FileProvider),
[Mozilla PDF.js canvas example](https://github.com/mozilla/pdf.js/blob/master/examples/learning/helloworld.html).
