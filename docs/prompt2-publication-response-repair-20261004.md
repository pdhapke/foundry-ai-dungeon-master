# Prompt 2 publication response repair — 2026-10-04

## Result and scope

Node source now distinguishes a committed preparation mutation followed by authorization revalidation failure from a failure before commit. This repair does not replay live publication, change the private campaign, use inference, build artifacts, or restart the stack. The previously published private candidate and its durable receipt remain the current evidence; live acceptance of the repair awaits the parent's coordinated build/restart with the Python stream repair.

## Contracts

- Service authorization phases and gateway initial/final authorization phases emit sanitized phase/error events. MCP authorization-tool failures retain only a closed error-code projection and three fixed tool names. No arguments, source prose, arbitrary codes, credentials, candidate IDs or receipt content are logged by the new telemetry.
- Mutation effects are tracked as `none`, `committed`, or `unknown`. Publication records a durable file receipt before SQL review completion; errors after that receipt retain `committed`. An unreadable receipt remains `unknown`. Untracked mutation paths conservatively retain `unknown` rather than assuming a successful write.
- A postcommit authorization failure returns HTTP 403 with `committed-revalidation-required`, `success:false`, and `currentAuthorizationVerified:false`. A committed operation/finalization failure uses HTTP 409 and `committed-status-required`. Unknown completion uses `outcome-unknown`; known precommit operation failures use `not-committed`; precommit authorization denial uses `authorization-required`. Every failure response uses static text and omits private payloads.
- Trusted effects pass from service to gateway through an in-process WeakMap. Imported JSON, copied results and sidecar data cannot forge commitment metadata.
- Completed or rejected review status reads load only the exact world/user/client scoped SQL review, after current authorization. They do not reload the candidate or active campaign files. Terminal results state `completionEvidence:historical` and `activeVersionVerified:false`; status is not a claim that the active files still match.
- Pending review and actual publication retain candidate/source/companion revision checks, browser approval, predispatch authorization and exact digest gates. Exact completed replay returns the historical saved status without publishing again. Final authorization remains required before returning its private details.

## Validation

The existing full server suite passed 435/435, with TypeScript no-emit checking passing before the final initial-authorization response refinement. Focused outcome tests cover closed telemetry codes, sanitized failure responses, distinct completion states and unforgeable effects. Independent fixture tests exercise the actual service, store, gateway, current authorization and replay. Final independent results are recorded separately in the private review evidence directory.

No compiled build or live endpoint test of this repair has run. Source implementation must not be described as loaded. The transport error which originally followed publication was not proven to be a timeout; the new telemetry is intended to distinguish that failure safely on a later authorized verification.

## Coordinated next step

After the parent's Python repair is ready, build the existing stack once, retain previous logs, restart only under today's verified visible-terminal override, verify fresh loaded identity, and perform an authenticated completed-review status read. A status read requires no publication replay or inference. Any further live trial or generation retains its existing separate budget and acceptance gates.

Final gate: the final source passes no-emit TypeScript checking. Independent repair gate **8/8** and dedicated outcome tests **4/4** pass, including an actual LatencySink privacy assertion. Evidence: `.runtime/foundry-ai-dungeon-master/preparation-reviews/izzy-campaign/prompt2-v5-consolidated-review-20261004/publication-response-repair-validation.md` (private, repository root). Earlier compatibility failures were fixed and the full existing server suite subsequently passed **435/435**. No live acceptance is claimed.

Final combined gateway/MCP/outcome/independent test run: **25/25 passing**, 3.8 seconds; retained private log: publication-response-repair-focused-final.log in the same evidence directory.
