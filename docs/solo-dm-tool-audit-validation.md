# Independent tool audit and build identity validation

Status: **PASS after independently verified repairs** (offline gate; no live acceptance claim).

Independent validator: session-backend worker, who did not implement the audit, HTTP health, startup identity capture, or Python health changes. Its session-backend self-tests are explicitly not an independent backend gate.

## Evidence

- A new authenticated HTTP contract test executes discovery, schema loading, grant execution and bounded pause state retrieval through the real ChatKitReadTools handler, catalog and native read adapter with a mocked MCP provider. A spoofed world is rejected before audit recording. Eight scoped attempt/result records map the loaded grant digest to its trusted tool/schema identity; execution invokes the provider exactly once even when the observer throws after persistence. Denied grants receive a denied result. No live Foundry behavior is established.
- Initial independent credential regressions failed: short key/value credentials in search queries and credential-shaped tool/action IDs were retained. Root repaired the audit implementation; both regressions now pass. Results omit raw grant tokens, raw argument/result documents, internal authentication headers and exception text.
- Existing focused tests verify scoped pagination, bounded retention, SQLite restart, denial/cancellation/uncertain records and safe verified pause receipts. Independently reviewed SQL scopes world/user/thread and the audit run uses a digest of the issued run capability.
- A new real handler cancellation regression initially failed: cancellation of the issued run was recorded as `error` because the handler tested only HTTP disconnect cancellation. Root repaired classification to consult the signal of the genuinely bound authorized run. The untouched cancellation assertion now passes with `attempt,cancelled`; no mutation is dispatched by this case. Authorization errors without an aborted run remain errors.
- New HTTP health verification captures startup artifacts, replaces an artifact in a real temporary filesystem, and confirms subsequent health responses retain the initial snapshot while a fresh capture differs. Missing artifacts are null and the scope explicitly requires separate Python/browser checks. This is evidence of startup on-disk artifact identity, not proof that the Foundry browser loaded that artifact.
- New Python TestClient verification confirms health reports the loaded startup code digest, loaded prompt digest and prompt version. Patching subsequent file reads and the separately imported prompt module leaves health unchanged; health does not re-read disk. It makes no model call.
- Wiring review confirms server startup constructs one ChatKitToolAudit against the existing database and passes its observer to the actual read adapter. Startup captures build identity once and passes that object to HTTP health. Python health uses its module-import startup constant.

## Checks

Final checks: ten focused TypeScript tests and one independent Python test pass. Full AI server type checking and targeted lint for all new independent TypeScript tests pass. Two test fixture constructors were corrected to use the provider's actual `{client, providerVersion}` contract; assertions and implementation under validation were unchanged by the validator.

## Backend registration preservation review (separate, non-independent)

Current local-api Git diffs retain the existing dirty bridge initialization/client-identity changes and endpoint acceptance/production-asset-root changes. This worker added only the shared contract export, module command import, endpoint import and endpoint-array spread. No whole-file formatter was used on those shared existing paths. A pre-edit byte snapshot was not captured, so this review cannot independently prove byte-for-byte preservation; use the orchestration baseline inventory/snapshot for that comparison. The new backend's own tests cannot substitute for an independent backend validator.

## Unperformed live checks

No embedded chat model call, loaded browser identity, runtime reload, world/scene switching, game mutation, credential/configuration change or direct privacy test was performed. A live end-to-end acceptance trace remains blocked by the approved offline-only scope and required model budget/live permissions.
