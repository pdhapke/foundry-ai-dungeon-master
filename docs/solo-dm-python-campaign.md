# Python campaign wrapper contract

The existing single ChatKit agent now exposes typed `campaign_read`,
`campaign_propose`, and `campaign_proposals` wrappers through its authenticated
response capability. Optional Python snake_case arguments map to the frozen
TypeScript camelCase contract. Proposed file objects reject extra fields and map
expected_revision/proposed_text to expectedRevision/proposedText. No approval or
commit tool is exposed to the model.

Read uses bounded relative paths/optional line spans; the TypeScript adapter
authoritatively validates world/user/thread, source containment, line ranges and
permissions. Proposal wrappers preserve stable proposal IDs and expected SHA256
revisions. They enforce 1..32 files and a 16000-UTF-8-byte batch allocation before
transport. The general adapter bounds requests/responses and validates response
envelopes. Canonical consistency, digest validation, exact review, durable
decisions and receipts remain TypeScript responsibilities.

Pending/stale/uncertain/privacy-denied responses are returned unchanged; Python
does not turn tool transport success into completed persistence. Current default
live private authoring returns storage_unavailable until privacy is verified.
The permanent prompt requires exact authenticated human approval and a verified
completed receipt before reporting canon or writes as completed.

Offline tests exercise exact wrapper arguments, privacy/status preservation,
input byte limits and a scripted draft -> externally simulated human decision ->
receipt -> later read sequence. That script proves wrapper contracts only; it
does not prove actual filesystem persistence, live model behavior or Foundry.
