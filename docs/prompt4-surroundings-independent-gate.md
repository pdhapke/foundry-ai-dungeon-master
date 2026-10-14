# Prompt 4 independent surroundings gate

Independent worker reviewed `server/src/chatkit/player-perception.ts`, `read-tools.ts`, and `context/world-campaign.ts`; created only the dedicated test file and this evidence document for this gate. No runtime changes or inference. This is an offline source/contract gate, not a live authenticated client or embedded browser claim.

Command: `node --import tsx --test server/src/chatkit/prompt4-surroundings-independent.test.ts`.
Result: **8 passed, 0 failed**. No imported preexisting test suite contributes to this count. Tests use a separate hand-built native report and temporary campaign source fixtures.

Passed independently:

- Generic closed-door description does not disclose locked state, labels, coordinates, native token/note IDs, source labels, errors, or private journals; exact public point description is admitted only for a visible unique query response with no uncertain attribution.
- Occluded point, wrong query ID, duplicated query ID, and uncertain environmental cause do not reveal authored point prose; seeing a point does not prove all scene visibility, threats, being noticed, or trap triggering.
- Mismatched intended client/user, GM substitution, revoked opt-in, missing ownership, unsupported vision, and false secret-door redaction flag produce no facts.
- Actual adapter object refuses disconnected intended player before native execution and preserves `NOT_CONNECTED`; no GM substitute.
- Public canonical point mapping uses exact scene and elevation; GM/private documents, scene-wide description scope, GM-ONLY section payloads, and raw Markdown links are excluded.
- Source parsing cache revalidates changed content and changed visibility; previously public content cannot survive a change to GM visibility.
- Actual authenticated read adapter contract withholds all facts when campaign source revision changes during the asynchronous native read.
- Malformed secret-door native evidence fails explicitly without emitting secret rationale; generic visible obstruction is not converted into darkness/trap explanation.

The initial test had an overly broad numeric-substring assertion: `400` also occurred inside observation UUID. Corrected the test to assert absence of coordinate field names and the actual prose disclosure values rather than matching arbitrary digest/UUID substrings. No implementation change was required.

Remaining limits: authored public prose is trusted only as declared public canon, not independently verified story truth; live native queries must still prove selected player's actual visibility. Live secret-door/multiple-source repairs, browser rendering, safe embedded action, loaded server/client identity, fixture restoration and approved inference narration are separate gates. A successful public point observation cannot authorize noticing a threat, being noticed, or triggering a trap. Strict no-model deterministic safe lane does not establish secrecy of unrestricted GM narrator.

Server TypeScript typecheck run separately; completion recorded in worker report.
