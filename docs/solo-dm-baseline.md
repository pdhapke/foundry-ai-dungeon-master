# Solo DM baseline — October 1, 2026

Phase 0 implementation inspection completed. Independent validation is recorded in solo-dm-ledger.md.

## Git boundaries and preservation

The AI module is its own Git repository at Data/Data/modules/foundry-ai-dungeon-master. Before documentation edits it was clean, on main, at 77b4516f5593b0bea6d914b6cad5c313bd7488c8. The parent index records mode 160000 and the identical commit. Existing origin is C:/dev/FoundryVtt/.tools/git-remotes/foundry-ai-dungeon-master.git; native Git reports it is bare. No Git initialization, remote change, persistent configuration change, commit, or push was performed.

Full initial dirty inventories are in baseline-evidence/*-dirty.txt. Parent changes include .gitignore, REPOSITORY.md, seven untracked orchestration/audit documents, and many deleted campaign files; these deletions were pre-existing and were not repaired. Dirty child repositories include foundry-local-api, digital-tabletops, dnd5e and trails-of-destiny. All unrelated changes and live world resources were preserved. The AI documentation ledger was created concurrently by the coordinator after the clean baseline.

No AGENTS.md was found by recursive repository search or at the ancestor roots C:/dev and C:/. REPOSITORY.md was read; its description of four submodules and missing remotes is stale relative to the verified AI submodule and existing bare origin. It is dirty already, so remains untouched.

## Runtime and installed tooling

Node v24.15.0 and npm 11.12.1 are installed; module requires Node >=24. Installed workspace dependencies and chatkit-server/.venv/Scripts/python.exe were used without installation. Python requirements are pinned in chatkit-server/requirements.txt. Server .env contains a signing-key setting; its value was neither displayed nor modified. Foundry configuration has port 30000, no configured default world, route prefix or TLS paths. Trusted server configuration resolves worldsRoot, runtimeRoot, optional sourcebook root, and Python/database paths. Defaults use loopback AI server port 3940, ChatKit port 3941, local API URL http://127.0.0.1:3939, worlds under Data/Data/worlds and a module-local runtime unless normal startup provides overrides. No service startup, fixture creation, model call, reload, or world switch was performed.

## Deterministic baseline evidence

All following commands exited 0; complete captured outputs are under baseline-evidence:

- npm test: bootstrap 7, shared 9, server 135, module 26; 177 passed, 0 failed.
- npm run typecheck: all workspaces passed.
- npm run lint: passed.
- npm run build: shared/server TypeScript and module bundling passed.
- npm run check:manifest: passed.
- chatkit-server/.venv/Scripts/python.exe -m unittest discover -s chatkit-server -p test_app.py: 14 passed.

Mocked Foundry and component tests prove deterministic contracts only; they do not prove live Foundry behavior. Build outputs did not create tracked code changes.

## Environment limitations

Native Git commands work. Some subprocess contexts use CodexSandboxOffline and reject parent/related repositories as dubious ownership. Read-only commands were rerun with an exact per-command safe.directory value; no global exception was added. Git also warns that the user global ignore file is unreadable. Inventories were captured successfully after the per-command adjustment. The previously reported shell-helper failure (basename/sed/git-sh-setup) was not used or repaired because no required native command depended on it. No pre-existing deterministic test failure was found.

## Changed paths and ownership

This worker owns docs/solo-dm-baseline.md and coordinator-approved docs/baseline-evidence/ inventories and logs only. No feature implementation or shared contract changes were made. Security/privacy, live behavior and billable acceptance remain gates for later phases.
