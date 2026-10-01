# AI Dungeon Master orchestration ledger

Updated: 2026-09-29

## Dependency and ownership matrix

| Phase | Outcome                                             | Owner                          | File boundary                                           | Depends on                                        | Status / evidence                                                              | Next action                          |
| ----- | --------------------------------------------------- | ------------------------------ | ------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------ |
| 0     | Architecture, contracts, baseline, trust boundaries | root                           | manifests, shared contracts, docs, integration points   | existing module inspection                        | complete; strict versioned contracts and separate module                       | live evidence only                   |
| 1     | Durable event/run/message/outbox store              | phase1 delegate + root         | `server/src/storage/**`, auth migration                 | Phase 0 contracts                                 | complete; SQLite replay/recovery tests pass                                    | retention policy later               |
| 2     | Revisioned recursive context service                | phase2 delegate                | `server/src/context/**`                                 | Phase 0 contracts, Phase 1 repository interfaces  | complete; 9 focused context cases pass                                         | expand reviewed seed routing         |
| 3     | Trusted catalog and deferred tool discovery         | phase3 delegate                | `server/src/tool-catalog/**`                            | Phase 0 contracts, external local-api descriptors | complete; 13 focused catalog cases pass                                        | review more exact-name capabilities  |
| 4     | OpenAI runner and proposal policy                   | root                           | `server/src/runner/**`, `policy/**`, `orchestration/**` | Phases 1–3                                        | bounded resolution complete; commit remains fail-closed                        | native safe commit provider contract |
| 5     | AI Dungeon Master window and transport              | root + independent review      | `module/src/**`, templates/styles, server transport     | Phases 0–1 transport                              | live v14 package/control/window smoke passed; authenticated connection pending | authenticated prompt smoke           |
| 6     | Trigger adapters                                    | root                           | module hooks and shared event protocol                  | direct prompt E2E                                 | implemented behind off-by-default setting; no movement                         | enable only after live direct path   |
| 7     | Independent review and live validation              | phase2/phase3 reviewers + root | tests/reports; root controls live processes             | all prior phases                                  | adversarial review complete; Foundry package/UI smoke passed in `mcp-test`     | authenticated prompt smoke remains   |

## Protected dependencies

- `Data/Data/modules/foundry-local-api/**` is pre-existing, dirty, independently versioned, and not
  owned by this implementation.
- `campaign/**` is canonical narrative state and is read-only unless a separately approved campaign
  migration is required.
- Live world Actors, Items, Scenes, combats, secrets, and campaign Journals are never destructive
  test fixtures.

## Baseline evidence

- Existing `foundry-local-api`: full tests pass; typecheck, format check, build, and manifest sync
  pass; lint reports 120 warnings and 0 errors.
- Existing shared test count observed: 49 passing. Existing module test count observed: 259 passing.
- New module current automated evidence: 7 shared, 55 server, and 5 module tests pass (67 total);
  typecheck, lint, formatting, build, generated docs, manifest check, and dependency audit pass.
- Generated surface: 2 loopback HTTP paths and 10 stable bootstrap tool definitions. Provider tools
  remain live/discovered; the initial exact-name overlay admits 7 and quarantines the remainder.

## Architecture decisions

- Separate module ID and directory: `foundry-ai-dungeon-master`.
- Separate local server; no OpenAI calls or credentials in the Foundry browser.
- Built-in Node 24 SQLite avoids a native third-party database binding.
- Existing local API is consumed through authenticated adapters, not modified in place.
- No interaction classifier. Context and tool discovery remain separate bounded services.
- Automatic movement triggering is disabled until movement-store health is explicitly proven.

## Independent review disposition

- Fixed: ApplicationV2 form wiring, cross-world delivery, nested payload validation, session expiry,
  reconnect cursor recovery, malformed delta cursor advancement, approval visibility, per-socket
  command serialization, reconnect timer behavior, session credential persistence scope, and Scene
  control ordering.
- Improved: composer/scroll preservation, structured cards, selected-user audience, context chips,
  GM diagnostics, and strict public chat escaping/read-back.
- Security review fixes: audience-wide presenter filtering for public/selected delivery, no
  pre-validation provider text streaming, cumulative output character enforcement, owner/GM-scoped
  cancellation, discovery/load binding for proposals, player diagnostic redaction, active-Scene
  validation, and unverified selected-document hint suppression.
- Open: authenticated prompt/live-provider smoke, lossless client-ack outbox delivery, provider-native safe
  commit capabilities, system-neutral roll hooks, voice, and movement health. These remain explicit
  limitations rather than completion claims.
