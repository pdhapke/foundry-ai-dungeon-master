# Forest generation handoff

The embedded module has no supported image-generation integration. `battlemap-generation-request` records a **manual secure ImageGen handoff**, without a provider invocation, image invocation, spend permission or automatic acceptance. Runtime generation and staging require the lead operator's separately approved prerequisites. Never replace generation with downloaded or historical artwork.

The DM request takes `worldId: "mcp-test"`, `prompt`, `name` and the originating `threadId`. The model adapter binds the thread to the authenticated ChatKit principal. The response contains the immutable request `id`, `promptDigest`, name and owner scope. Retries recover the same record; a different request in the same GM thread refuses. The existing forest fixture and Scene `d4a3598b1436415f` are preserved.

After the operator verifies live test-world GM identity and the approved generation allowance, generate exactly one new player-safe gridless image through the approved secure handoff. Stage only that output, with no overwrite or redirected path, in the server's **private** configured preparation jobs root:

```
<jobsRoot>/local-assets/mcp-test/generation-incoming/<request-id>.png
<jobsRoot>/local-assets/mcp-test/generation-incoming/<request-id>.json
```

The JSON receipt must contain these fields. Obtain request ID and prompt digest from the recorded request/status, never infer them from the image or a different conversation:

```json
{
  "requestId": "<64 lowercase hex request ID>",
  "promptDigest": "<exact recorded promptDigest>",
  "integration": "secure-imagegen-handoff",
  "imageCount": 1,
  "sourceHash": "<SHA-256 of the staged PNG bytes>",
  "sourceWidth": 1024,
  "sourceHeight": 1024,
  "generationRef": "<actual secure generation result reference>",
  "license": "<approved generated artwork provenance/license>",
  "playerVisibleApproved": true
}
```

The dimensions must match the PNG and each be 320–8192 pixels. PNG size is limited to 32 MiB; receipt size to 8,000 bytes. Completion checks the recorded scope, paths, PNG signature, hash, dimensions, one image, player-safe approval, generation reference and license. It rejects the historical source hash and an image/reference already completed for another request. Private receipt staging is a trusted operator boundary; the module cannot independently verify an external provider invocation. `providerRequests: 0` describes this module's requests only; `imagesImported` counts imports and `imageInvocationsVerified: false` preserves this distinction.

In the normal GM Forest panel, enter the request ID from the current conversation. **Check new image handoff**, then **Import securely staged new image**. The panel attaches the current conversation ID automatically. Model tools cannot complete, import, review, apply or display the handoff. A new fixture name includes the request ID suffix. Keep this ID selected for prepare, exact review, apply, receipt checks and viewport fitting.

TV preparation requires one exact authenticated opted-in TV companion, fresh fullscreen display evidence, and Digital Tabletop's current 955 mm width setting. Put the actual TV browser in fullscreen (F11) before preparing; changing the viewport afterward requires another preparation/review. Creation retains an inactive Scene with navigation disabled and default ownership zero. **Display reviewed forest scene** views that exact fixture locally on the consented TV, preloads the imported asset, and uses the installed Digital Tabletop calibration through its shared physical-scale API. It does not activate a Scene globally or change user roles or ownership. Physical acceptance remains pending until an actual ruler measurement. The camera prioritizes one-inch squares; image aspect ratio is preserved and margins or panning may be necessary. Mock acknowledgements prove the offline contract, not TV rendering, automatic generation, or physical accuracy.
