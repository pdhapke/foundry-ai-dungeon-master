# Prompt 2 bounded evaluation

Synthetic offline fixture only. Detailed evidence is emitted by `scripts/prompt2-independent-validation.test.ts` into `prompt2-independent-final-server.log` and independently assessed in `prompt2-independent-final-gate.md`. No real model or campaign preparation output is evaluated.

| Case/query | Expected IDs | Retrieved IDs |
|---|---|---|
| Starting quest / lighthouse | quest | quest |
| NPC motivation / brother | motivation | motivation |
| Location details / stone piers | location | location |
| Unresolved event / courier vanished | event | event |
| Cross-record relationship / serves | relationship | relationship |
| Corrected fact / sunset | corrected | corrected |
| Rumor / ghost | rumor | rumor |
| Private trap / needle (GM) | trap | trap |
| No supported answer / unsupported dragon ancestry | none | none |

Zero missing expected records and zero fixture secrecy failures. Player trap lookup is empty; public relationships exclude invisible targets; private source URIs/count/error metadata are withheld. Whole-word conjunctive queries repair the discovered `ghost ship`/`relationship` false positive. Arbitrary typos and semantic search are unsupported.

Index input:8 records/8 qualified whole sections,4077 serialized bytes. Disposable in-memory index, no embedding/FTS file. One small warm run measured approximately0.04–1.05ms/query; these are local fixture observations, not live performance acceptance. Results ranged112–492 serialized bytes. Current real source completeness, starting-situation quality and narrative usefulness are separate unaccepted gates.

Area/map/population coverage: existing-area reuse, repeat request/stage IDs, cancellation/resume, stale sources/deletions, actor/token bounds, private structured inactive traps, mocked native adapter receipt recovery, measured opposite-edge grid spacing/origin/distortion and non-applied geometry impacts. Production scene creation/population and physical TV display remain blocked/unverified. No image generation or live scene import was run.
