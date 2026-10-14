# Application source recovery

Candidate only: application-reconstructed.ts. Original source was truncated by another worker; this recovery used the latest recovered pre-Phase4 tsx transformation, not Git HEAD. The preserved compiled module bundle was neither rebuilt nor modified.

The installed TypeScript printer formatted the transformation. Type-only declarations restore public request/fetch/context signatures, nullable lifecycle fields, cancellation signals, component interface and DOM views; callbacks for dynamic provider/review JSON have explicit broad annotations. No whole-file nocheck is used. Original comments, exact type declarations, formatting and source bytes cannot be recovered from a transformed JavaScript cache.

Full module TypeScript check with compiler-host virtual substitution at the original source path: zero diagnostics, including final formatting (typecheck-gate.json). No actual source write was needed to test the candidate.

Canonical complete-module JS comparison via installed esbuild, after type erasure and syntax/whitespace normalization with identifiers preserved: both 32700 bytes, exactly equal, SHA256 d70c63e57077f43c0cb39dd1e9aaa4629752fafd0b009186fe8f646937c4c31c (canonical-runtime-gate.json). This includes imports, helper functions, static/private class state and exports; it proves recovered runtime equivalence to the saved transformation, not source-byte identity. Independent comparison to the preserved bundle and source-restoration permission are parent-owned gates.

No feature additions, service lifecycle, inference or live actions were performed during recovery.
