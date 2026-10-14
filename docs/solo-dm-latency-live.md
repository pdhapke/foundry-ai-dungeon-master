# Embedded pause latency evidence

2026-10-01 read-only inspection; no new model requests or game mutations. User approved subsequent isolated live acceptance, maximum two model requests/eight steps each. Privacy configuration remains unchanged.

Existing embedded chat displays unpause “Thought for 47s” and pause “Thought for 38s”. These labels are UI-reported durations, not instrumented full-turn wall time. Foundry UI displayed 5ms connection latency and paused state.

Read-only operations.sqlite audit confirms first-request search → both schemas loaded → authoritative initial pause read → completed setter receipt → independent final pause read for each request. No reminder was needed.

| Adapter operation | Unpause seconds | Pause seconds |
| --- | ---: | ---: |
| Search | 1.732 | 1.323 |
| Both schema loads, overlapping elapsed span | 3.048 | 2.177 |
| Initial state read | 4.406 | 4.023 |
| Setter, including verified receipt | 5.385 | 4.950 |
| Final independent state read | 3.801 | 3.792 |
| Total non-overlapping audited operation spans | 18.372 | 16.265 |

Search began 23:45:50.078Z and final unpause read returned 23:46:33.947Z (43.869s span). Pause search began 23:46:56.370Z and final read returned 23:47:31.255Z (34.885s). Remaining gaps include model decisions and adapter/gateway work outside these spans; they cannot be attributed exclusively to model reasoning without instrumentation.

Setter receipts: unpause-game-20261001T2346 completed with readBackPaused=false; pause-game-20261001T2347 completed with readBackPaused=true. Subsequent authenticated direct MCP getter independently returned paused=true. Runtime lists 260 tools and both native pause getter/setter schemas. Current server health advertises build manifest 656bc2320eb3f9768be00902bd921259007c6e88304de43eb118edcba51b2f93; Python health code digest 9e5adb0988de7aac7ce5905ad243f395aaf806b5bfabad4049b2d14da27cb061 and prompt digest c438f5ab3e85f274331657f506e6c8c6b02eb1ccc8fa42d4cd5ab10ca36e5fe6. This confirms identity instrumentation is running; exact artifact comparison remains a separate check.

Recommendations and source-derived call accounting: solo-dm-latency-source.md. Independent assessment: solo-dm-latency-validation.md. This evidence establishes real pause discovery/execution/readback, not full world-control, trigger, or privacy acceptance.
