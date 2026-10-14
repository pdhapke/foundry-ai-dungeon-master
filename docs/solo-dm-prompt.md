# Permanent solo DM assignment

`chatkit-server/dm_prompt.py` contains the static, versioned `solo-dm-v6`
assignment. It applies through `build_agent` on every ordinary response;
application actions call that same `respond` path and existing single model loop.
No new runner or mode-dependent identity was added.

The assignment covers conversational setup/preparation/play, player agency,
rules-system uncertainty, guaranteed overview/current party context, bounded
retrieval/discovery, draft separation, exact human approval, verified persistence
and action receipts, spoiler handling, and untrusted source instructions.
Unavailable tools/storage remain explicit limitations; the prompt does not claim
a capability has been implemented just because it describes how to use one.

Offline tests verify static policy/version and AST wiring to both entry paths.
These checks do not prove live model compliance, privacy or successful Foundry
execution. Live acceptance requires separate authorization and budget.

The current policy requires discovery on the first direct game-control request, including please unpause the game. Authenticated GM authority spans the active world through typed adapters; routine actions do not need repeated confirmation. Destructive changes, executable code, host administration and private storage retain their separate controls. Running model behavior must be observed through actual tool traces and authoritative read-back, never inferred from this prompt.

