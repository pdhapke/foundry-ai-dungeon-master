import { register } from "node:module";
import { URL } from "node:url";

// Source-only tests use the public API facade's source implementation. Production
// continues to import its compiled facade and never enables this testing hook.
register(new URL("./test-events-core-loader.mjs", import.meta.url));
