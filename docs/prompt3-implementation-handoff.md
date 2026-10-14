# Prompt 3 compact AI DM implementation handoff

2026-10-04. Offline implementation gate passed; combined build/deployment and real
browser acceptance remain open. No live model submissions, embeddings, images,
paid services, account changes, campaign edits/publication, gameplay mutations,
push, runtime shutdown/startup or client reload occurred. Existing unrelated work
and private campaign storage were preserved. No campaign-preparation server,
Python or MCP source was edited by Prompt3.

## Delivered UI and lifecycle

Healthy play has a Model selector and native Account/settings details menu.
Permanent Ready/context prose, redundant model-available tag, healthy domain
instructions and authenticated sign-in controls are absent. Provider/model and
domain/CDN failures remain visible; a delayed successful preparation check cannot
hide a mount/request failure. Exact normal preparation-cache expiry has no idle
banner, but still invalidates readiness and is checked before the next submission.
Actual expired authentication remains visible. Model defaults, provider/billing,
domain registration, browser/current-GM permissions and approval policy are unchanged.

The menu retains model-free Check connection, signout/account switching, exact
actions/receipts, Player surroundings and Prompt2 Campaign setup. Recovery works
while disconnected through the existing disconnect/connect transport and never
submits inference. The native menu supports keyboard navigation/Escape; no iframe
or shadow DOM access was added. Settings changes invalidate stale work and retain
a corrective warning; the chat frame is applied on explicit reopen, preserving
the composer rather than silently replacing it. Server URL changes reconnect the
existing transport with fresh proof. Diagnostics are behind client Boolean
`latencyDiagnosticsEnabled`, registered false by default, strict true to expose
the existing bounded metadata-only export. Automatic gameplay events stay disabled
by their existing independent setting.

Prompt1 PanelPreparation remains the single readiness owner. Manual concurrent
checks share preparation. The provider status path coalesces initial connection,
panel open/reconnect and recovery, waits for actual matching replies, has a one
second success cache and at most two failure retries with backoff. Close cancels
status work/timers; ordinary status does not poll. OAuth completion retains source/
origin validation and its fallback is bounded to six checks. Existing Foundry
credential renewal introduces no provider discovery/action replay. Retired
discovery IDs are bounded; older discovery cannot overwrite new provider mutations.
Meaningful invalidation while pending permits one fresh follow-up, not duplicate
concurrent requests.

## Two safety controls

**Stop** is visible only during queued/active response work. It cancels local
queues/streams and propagates cooperative disconnect cancellation upstream.
Dispatched tools/provider work may still complete. It neither rolls back confirmed
changes nor guarantees zero inference cost. Its visible outcome directs receipt
inspection before retrying; durable history, protocol pairs and confirmed receipts
are not removed. Cancellation before the tool completion/acknowledgement hook
can remain uncertain. Installed ChatKit1.9.0 types expose no public cancel method;
whether the loaded CDN composer already supplies equivalent Stop is still a
visual gate, not inferred from types.

**Review proposed actions and receipts** includes required note/campaign/world/
world-file approvals and consequential recorded attack decisions, plus confirmed/
uncertain history. Every existing exact scope/digest/expiry/decision handler is
retained. The menu opens the review drawer; pending proposals reveal it contextually
on restored-thread ready, thread selection and completed responses. Each trigger
uses one coalesced five-kind read-only list batch, with thread/epoch fences and no
model call/autoapproval. Invalidation closes stale panes; receipts remain reachable
through the menu after cancel/reconnect.

## Evidence and remaining gate

Independent final module run92/92 and module typecheck passed:
`prompt3-final-module-tests.log`, `prompt3-final-module-typecheck.log`,
`prompt3-independent-gate.md`. Worker/focused counts overlap and are not additional
unique tests. Relevant tests cover auth/model failures, delayed domain-error
readiness, Stop/queue cancellation, close/reopen/expiry/backoff, old status races,
model-free reconnect, settings guards, flag registration, stored pending-review
coalescing and exact approval safeguards. These are offline mocks/source checks,
not actual provider/tool cancellation or visible keyboard/layout acceptance.

Detailed reports: `prompt3-control-audit.md`, `prompt3-layout-report.md`,
`prompt3-lifecycle-report.md`, `prompt3-runtime-baseline.md`.

Aggregate build/restart is **held at the parent's explicit Prompt2 coordination
gate**. Prompt3 frontend source is ready to join that batch. No module bundle was
built here. After the parent gate opens, run the combined workspace/bridge builds
as needed, gracefully stop only the verified foreground alias stack, verify
listeners/processes/lock exit, then relaunch `foundry` in visible persistent Git
Bash with logs preserved. Never claim source changes are loaded merely from disk.
Verify every startup artifact/Python digest against disk and the browser's new
`module.api.build.compactPanel === "prompt3-v1"` marker separately.

Fresh read-only baseline: Foundry30000/PID47912, MCP3939/PID2276,
AI3940/PID13536, Python3941/PID45948; known mintty ownerPID23132.
AI startup53artifacts/45matching disk, MCP15/15, Python source mismatch,
promptv9/normal15turnlimit, requests0. The last designated browser state in the
handoff was locked setup/no active world; this session could not freshly inspect it.
Protected overview/index publication and native map composition belong to the
parent/Prompt2, not this implementation. Their absence is not Ready.

No callable trusted node_repl/browser/desktop tools exist in this environment.
The installed browser/Computer Use packages require that trusted service; their
presence alone does not provide supported observation/input. No blind input,
custom desktop workaround, raw CDP or hidden launch was attempted. Therefore
baseline/after screenshots, actual viewport dimensions, usable pixel delta,
composer/menu scrolling/clipping, native Stop and loaded UI identity remain open.
Source default620x720 and reduced host minimum280to120px are not measured space
gains. Complete this gate in a supported browser/desktop environment after loading
the combined build; unlock setup/launch izzy-campaign/join GM if needed. If terminal
control remains unavailable, the smallest manual step is Ctrl+C in the verified
foreground terminal, then `foundry` there after stack exit has been verified.
Stop for Peter's visual feedback before additional redesign or live inference.
