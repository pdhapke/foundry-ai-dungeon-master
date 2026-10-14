# Independent pause validation

October 1, 2026. Validator did not implement pause request parsing, pause actions,
catalog pause facade, gateway authorization forwarding or permanent prompt v4.
The validator implemented the separate audit observer; that component requires
another independent validator and is excluded from this gate.

## Initial gate: FAIL

The new independent pause-request.validation.test.ts reproduces rejection of
the actual saved ordinary requests: “can you unpause the game?”, “can you unpause
the game please?” and “Here we go, can you unpause the game please”. The initial
parser recognizes only imperative pause/resume/unpause, optionally prefixed by
please. Consequently these natural first requests cannot authorize a discovered
setter. Actual first case returned undefined instead of {paused:false}.

Independent quoted/negated/historical/compound/automatic input regressions PASS.
Initial pause parser/action tests and independent parser tests: 5 PASS, 1 FAIL.
Server typecheck separately FAIL during concurrent routine parser integration:
gateway.pause.test.ts captured {paused:boolean}, incompatible with new optional
paused/sessionKinds callback contract. Both failures were reported to root and
the implementation owner. Independent regressions remain unchanged.

## Repair revalidation: PASS offline

The implementation owner repaired natural request recognition while retaining
strict whole-message matching and excluding quoted/negated/historical/compound/
automatic instructions. The three actual saved first-request phrases now pass
the original independent test unchanged. Root repaired the gateway callback
test type. Revalidation ran nine tests across pause request/action author tests,
both independent regression files and gateway intent forwarding: 9 PASS, 0 FAIL.
Independent test-file lint PASS. Permanent prompt v4 directs discovery on the
first request and requires authoritative completed read-back receipts.

Aggregate server typecheck remains separately blocked by concurrent, non-pause
session-actions.ts work (line 96 union access to text). The prior gateway pause
type error is absent. This does not invalidate pause test evidence, but the
final aggregate gate must wait for that implementation and rerun typecheck.

## Safety/execution evidence

Source inspection confirms gateway derives intent from the current authenticated
ordinary request body; automatic custom actions cannot authorize pause. The
server forwards captured intent into a run, rather than accepting model-supplied
authorization. Explicit desired Boolean must match the setter argument. The
native action checks live GM identity, world/user/thread scope and revocation,
reads before dispatch, validates actual MCP schemas, rechecks state/schema/auth
immediately before dispatch and verifies authoritative post-read.

The semantic catalog facade uses scoped discovery/schema grants; raw setters
remain unavailable. Existing author tests exercise discovery/load/execute,
schema drift, grant/replay conflicts, cancellation, revocation, stale state,
already-false no-op and durable uncertain replay. New independent
pause-actions.validation.test.ts separately proves wrong read-back and revocation
after dispatch produce uncertain and do not dispatch again after service
restart; wrong world/user/empty thread/desired Boolean mismatch denies before
MCP reads. Six action/parser tests PASS in that focused run; independent test
files lint PASS. Tests use controlled MCP fixtures and real SQLite, not live
Foundry actions.

Audit observer validation, broad routine actions and capability coverage belong
to separate gates. Runtime inventory proves actual bridge pause getter/setter
availability and getter paused:true, but the older built DM catalog lacks pause.
Source/build files do not prove loaded process identity. Embedded-chat calls,
actual mutation/read-back, approved reload and billable model behavior remain
unperformed; see solo-dm-pause-runtime.md. Do not claim live acceptance from this
offline gate.
