# Phase 4D.3 — Message cards and chat cleanup

Scope follows the [Notion Task](https://app.notion.com/p/4035421e690b81ef9918c4f2d290431a).

User and assistant messages share left-aligned cards and avatar/name headers. Defaults are
「你」 with a person outline and Codex with the approved Oracle Eye. Bodies use the full
card width, without an avatar column. The desktop content container is capped at 980 CSS
pixels including padding; mobile uses 10px outer gutters and 12px card insets. Existing
Violet, Hong Kong Rain and Minimal Light materials apply to both roles.

Theme API v1 remains unchanged. `.message`, `.message-heading`, `.message-avatar`,
`.message-name`, `.message-body`, both role classes and the two message slots are documented
in [THEMING.md](THEMING.md). Trusted CSS can override the card material and layout. User
text remains plain text; assistant Markdown, copy, code scrolling and Diff use the existing
renderers. No grouping, identity upload or nickname persistence is introduced.

Normal chat no longer renders session/event/receipt dumps, raw approval envelopes,
internal-ID labels or per-item persistence diagnostics. Less common native records retain
their original position and status, with an explicit detail entry into the Inspector;
raw technical details there are collapsed. Meaningful MCP inputs/results and requested
permissions remain available for understanding tool work and consent.

Execution, completion, failure and interruption remain visible. Unknown/accepted send
protection, disconnect/reconnect, incomplete-history notices and approval controls are
unchanged. Network targets and terminal-input approval kinds are readable without protocol
JSON. Exact current-session permission facts are available under Settings → 当前会话权限详情.
The Bridge, authentication, receipts, deduplication and approval routing are not modified.

## Verification

```sh
pnpm check
pnpm test
pnpm build
pnpm test:messages:ui
pnpm test:ui:mock
pnpm test:phase3:ui
pnpm test:phase3:mobile
pnpm test:themes:ui
pnpm test:native:ui
pnpm test:permissions:ui
pnpm test:lifecycle:ui
```

The message UI contract runs real Electron and simulated mobile Chromium with controlled
native protocol fixtures. It checks four themes plus custom CSS, responsive widths,
Markdown/code/Diff, reading/drafts/composition, approvals/Stop, errors, reconnect and receipt
uncertainty. Receipt assertions query authenticated Bridge snapshots instead of depending
on a visible developer dump. Existing scripts use DOM identity metadata rather than ID text.

`pnpm test:messages:live` is opt-in. It requires the installed production Bridge already
stopped, a free loopback port 17860 and the existing Android Debug client pointed at that
entry. It starts an isolated authenticated source Bridge, sends exactly one bounded
text-only official Codex turn, and checks both actual clients. It backs up and restores
phone cookies/local/session storage, restores ADB mappings, deletes only its own test
thread and verifies the installed service remains stopped. It does not rebuild/install an
APK, deploy a DEB or alter production services. Private evidence is under
`.local/evidence/phase4d3/`; a failed cleanup retains its private recovery backup.

The live runner distinguishes actual Android IME keystrokes, composition commit and Enter
from simulated composition events. It preserves the active IME rather than assuming literal
Latin output. This is not full manual Chinese candidate-selection or Android Release/public-
network acceptance. Actual results, limitations, screenshots and Git SHA are
recorded in the Notion Task, which stays In progress for independent review.
