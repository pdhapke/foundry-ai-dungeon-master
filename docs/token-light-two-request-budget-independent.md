# Embedded token-light test budget gate

The approved maximum of TWO total model requests cannot reach the setter through the current normal embedded path. No allowance or test submission should be created or consumed for that expectation.

Inspected production contracts establish three dependent response rounds as a lower bound:

1. Request 1 calls tool_search and receives a random run-local searchId.
2. Request 2 calls tool_load with that returned searchId and tool ID, receiving a random run-local grantId and exact schema.
3. Earliest request 3 calls tool_execute with that returned grantId and bounded session mutation arguments.

Same-response parallel calls cannot use results which the model has not received. runtime.ts stores searches/grants in the current ToolCatalogRunSession maps; load rejects tools not returned by this run's search and execute rejects unknown/foreign grants. IDs are randomUUID-based. ChatKitReadTools creates discovery state for each fresh read run and releases it at run end; operator/previous-conversation grants cannot be reused or fabricated. Python's 30 tools expose generic search/load/execute, not a direct token-light setter. Prewarming provider/context/catalog does not preload a valid grant into model history.

Three is only the earliest setter lower bound, not a guaranteed successful test budget. Setter requires current authoritative expectedState; obtaining it can add a dependent read round. Existing receipt-only finalizer excludes generic tool_execute/token.light and requires one request/one call, so ordinary post-result factual model finalization may require another request. Player choices, uncertainty or additional rules can also stop rather than complete. No speculative live calls were used to estimate this.

Source evidence: chatkit-server/app.py generic tools and finalizer contracts; server/src/tool-catalog/runtime.ts search/load/execute maps and random IDs; server/src/chatkit/read-tools.ts run creation, current authorizer and discovery ownership. No source edits, inference, allowance activation, native/UI mutation or restart by this reviewer.

Report budget blocked before usage. Any larger exact ceiling requires fresh budget review/approval; alternatively a separately authorized routing implementation could be reviewed and tested offline first. Do not silently raise caps, bypass discovery grants, expand the core tool surface or reinterpret two requests as two user prompts.
