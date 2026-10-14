# Independent Phase 1 storage validation — October 1, 2026

Offline storage gate: **PASS after repair**. Live direct-file privacy remains **FAIL**, protective deployment **BLOCKED**. This is not a full live Phase 1 pass.

## Repair and regression evidence

Initial validation found that recover rejected legitimate JSON journals over maxBatchBytes * 8, while commit could produce larger serialized snapshots. The implementation owner repaired this with a shared maximum derived from 32 prior file snapshots, sixfold JSON escaping, bounded path/world identifiers, and structural overhead. Writer and recovery now enforce the same cap; configuration budgets are positive bounded safe integers. Default maximum journal size is 24,617,776 bytes. The original independent regression was unchanged and now passes: six accepted 128,000-byte files with escaped control content, interrupted replacement, rollback and exact original-text recovery.

## Independently exercised checks

- Six implementation storage tests and two independent validation tests pass on real Windows temporary files.
- Traversal, ADS, reserved names, actual directory-junction escape, per-file/batch bounds, stale revisions, world isolation, authorization revocation, default privacy-write denial, incomplete-transaction read refusal and staging rollback are covered.
- Added a real child-process concurrency/crash test. The child writes the journal and first resource, then holds its live lock. A separate repository instance rejects an overlapping commit and refuses a partial read. The validator kills the child, waits for confirmed process exit, removes the stale lock as the documented operator step, and verifies recovery restores the old resource and removes the uncommitted new resource. No mocked filesystem substitutes are used.
- npm run typecheck passed across all workspaces after the independent process test. The validator's new test was formatted with the repository formatter.

## Limits and remaining gates

Authorization/privacy callbacks are fixtures and prove repository invocation behavior, not live Foundry revocation or protected HTTP serving. Live authoring remains disabled; existing Izzy campaign resources are untouched. File fsync/rename provides bounded recoverability, not simultaneous multi-file visibility or verified power-loss durability. Recovery after a killed writer deliberately requires confirmed process death before stale-lock removal; automatic lock theft is not claimed.

Node's documented Windows noncooperative filesystem race limitation remains: administrators must not replace path components during repository operations. Offline PASS applies to cooperative writers and trusted server-root configuration. Direct HTTP privacy deployment and live authorization acceptance remain separate required gates.

Changed paths: this report and server/src/context/campaign-storage.validation.test.ts only. Implementation changes were made by the storage owner, not this validator. Contract changes: none. Storage repair blocker: resolved. Deployment privacy blocker: unchanged.
