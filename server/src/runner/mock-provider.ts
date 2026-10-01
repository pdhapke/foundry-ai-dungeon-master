import type { AiDmProvider, AiDmProviderRequest, AiDmProviderResponse } from "./types.js";

export class DeterministicAiDmProvider implements AiDmProvider {
  readonly requests: AiDmProviderRequest[] = [];
  #responses: AiDmProviderResponse[];

  constructor(responses: AiDmProviderResponse[]) {
    this.#responses = structuredClone(responses);
  }

  createResponse(request: AiDmProviderRequest): Promise<AiDmProviderResponse> {
    if (request.signal.aborted) throw request.signal.reason;
    this.requests.push(request);
    const response = this.#responses.shift();
    if (!response) throw new Error("Deterministic AI Dungeon Master provider has no response.");
    return Promise.resolve(structuredClone(response));
  }
}
