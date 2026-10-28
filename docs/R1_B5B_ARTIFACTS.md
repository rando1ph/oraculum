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
MIME, `nosniff` and `no-store`. Errors contain neither host paths nor raw OS stacks.
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

## Acceptance

Use isolated projects and synthetic fixtures only. `bridge/src/artifacts.test.ts`
checks real authenticated HTTP responses, scope/type/path restrictions, stale
versions, replacement races, revoke/abort/timeouts and resource cleanup. Native
SAF/provider/reader behavior on a signed Android Release remains B8 acceptance;
Kotlin/JVM checks and Chromium touch simulation do not replace it.
