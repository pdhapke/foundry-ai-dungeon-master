# Narrow session action backend

The additive `foundry_get_session_action_state` and `foundry_apply_session_action` endpoints in foundry-local-api share a strict discriminated input schema. They accept a world ID and requesting user ID supplied by the authenticated AI adapter, never an arbitrary document patch. The bridge independently requires the current bridge user and requesting user to be active GMs in the matching live world. Scene operations additionally require the active scene.

| Action | Scope | Preflight/read-back |
| --- | --- | --- |
| actor.hp | Current-scene dnd5e actor, integer 0..existing maximum | HP value and maximum |
| actor.condition | Current-scene actor; only IDs from trusted CONFIG.statusEffects | Actual actor.statuses membership |
| door.state | Current-scene Wall that is a door; exact 0/1/2 state | ds |
| token.position | Current-scene token, finite nonnegative coordinates within scene bounds | x/y |
| combat.next | Started active combat on current scene; standard next index, wrapping round | round/turn |
| combat.initiative | Existing combatant in that combat, finite bounded exact initiative | round/turn/initiative |
| playlist.sound | Existing world PlaylistSound, playing/paused/stopped only | playing/pausedTime |
| chat.post | At most 4000 plain text characters, no angle brackets | Created document ID/content; independent getter accepts read-only messageId |

Apply requires the exact previously read `expectedState`, a server-generated correlation ID and a durable idempotency key. The immediate pre-dispatch comparison has no intervening await. This is optimistic preflight, **not atomic Foundry core CAS**; another client can race the mutation. The AI adapter owns durable deduplication and uncertain-result handling. The endpoint does not claim independent durable replay protection and must not be blindly retried.

Document updates carry executor-owned `correlationId`, `foundryLocalApiOrigin` with source `foundry-local-api.session-action` and phase `apply`, and the existing authorized GM movement marker. Model fields cannot supply arbitrary update options. Single-operation updates have no automatic rollback or compensation: failed or mismatching read-back is uncertain and requires inspection.

Limitations requiring live gates: mocked Foundry tests establish contract behavior only; they prove neither loaded build identity nor live API correctness. Actor.toggleStatusEffect may ignore additional correlation options internally; quarantine condition execution until its authoritative origin behavior is validated if trigger loop suppression depends on those options. Standard combat index advancement does not reproduce custom system next-turn semantics or skip-defeated automation. Token movement needs the existing movement/Region authoritative correlation bridge before unrestricted activation. Playlist document read-back does not prove audibility. No active configuration, loaded module, fixtures, credentials, world, scene, or network settings were changed to validate these additions.
