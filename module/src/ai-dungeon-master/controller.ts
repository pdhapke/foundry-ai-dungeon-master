import type {
  AiDmAutomaticEventSubmit,
  AiDmRequestedAudience,
} from "@foundry-ai-dungeon-master/shared";

import { AiDmClientStore } from "./store.js";
import { AiDmTransport } from "./transport.js";

export interface AiDmControllerTransport {
  connect(): void;
  send(command: Parameters<AiDmTransport["send"]>[0]): boolean;
  beginChatGptSignIn(): boolean;
  chatKitHeaders?(): Record<string, string>;
}

export class AiDmController {
  readonly store: AiDmClientStore;
  readonly transport: AiDmControllerTransport;

  constructor(store = new AiDmClientStore(), transport?: AiDmControllerTransport) {
    this.store = store;
    this.transport = transport ?? new AiDmTransport(store);
  }

  connect(): void {
    this.transport.connect();
  }

  submitPrompt(text: string, requestedAudience: AiDmRequestedAudience): boolean {
    const trimmed = text.trim();
    if (!trimmed || !this.#canSubmitRequest()) return false;
    const controlled = canvas?.tokens?.controlled ?? [];
    const targeted = (canvas?.tokens?.placeables ?? []).filter(({ isTargeted }) => isTargeted);
    return this.transport.send({
      type: "aiDm.prompt.submit",
      payload: {
        requestId: crypto.randomUUID(),
        text: trimmed,
        requestedAudience,
        contextHints: {
          ...(canvas?.scene?.id ? { sceneId: canvas.scene.id } : {}),
          controlledTokenIds: controlled.flatMap((token) => {
            const id = token.document?.id ?? token.id;
            return id ? [id] : [];
          }),
          controlledActorIds: controlled.flatMap((token) =>
            token.document?.actorId ? [token.document.actorId] : [],
          ),
          targetTokenIds: targeted.flatMap((token) => (token.id ? [token.id] : [])),
          selectedDocumentUuids: [],
        },
      },
    });
  }

  submitEvent(payload: AiDmAutomaticEventSubmit): boolean {
    if (!this.#canSubmitRequest()) return false;
    return this.transport.send({ type: "aiDm.event.submit", payload });
  }

  cancel(runId: string): boolean {
    return this.transport.send({
      type: "aiDm.run.cancel",
      payload: { requestId: crypto.randomUUID(), runId },
    });
  }

  decide(proposalId: string, proposalRevision: string, decision: "approve" | "refuse"): boolean {
    return this.transport.send({
      type: "aiDm.approval.decide",
      payload: { requestId: crypto.randomUUID(), proposalId, proposalRevision, decision },
    });
  }

  beginChatGptSignIn(): boolean {
    return this.transport.beginChatGptSignIn();
  }

  refreshChatGptStatus(): boolean {
    return this.transport.send({
      type: "aiDm.chatgpt.status",
      payload: { requestId: crypto.randomUUID() },
    });
  }

  signOutChatGpt(): boolean {
    return this.transport.send({
      type: "aiDm.chatgpt.signout",
      payload: { requestId: crypto.randomUUID() },
    });
  }

  selectChatGptModel(model: string): boolean {
    const { state } = this.store;
    if (
      state.authenticatedLane !== "gm" ||
      !state.chatGpt.planUsageAuthorized ||
      state.chatGpt.modelSelectionPending ||
      !state.chatGpt.availableModels.some(({ slug }) => slug === model)
    )
      return false;
    const sent = this.transport.send({
      type: "aiDm.chatgpt.model.select",
      payload: { requestId: crypto.randomUUID(), model },
    });
    if (!sent) return false;
    this.store.setModelSelectionPending(true);
    this.refreshChatGptStatus();
    return true;
  }

  setAllowAllPlayerRequests(allowAll: boolean): boolean {
    return this.transport.send({
      type: "aiDm.player-requests.policy.set",
      payload: { requestId: crypto.randomUUID(), allowAll },
    });
  }

  decidePlayerRequest(playerRequestId: string, decision: "approve" | "refuse"): boolean {
    return this.transport.send({
      type: "aiDm.player-request.decide",
      payload: { requestId: crypto.randomUUID(), playerRequestId, decision },
    });
  }

  #canSubmitRequest(): boolean {
    const { state } = this.store;
    return (
      state.connection === "connected" &&
      (state.authenticatedLane !== "gm" || state.chatGpt.state === "ready")
    );
  }
}

export const aiDmController = new AiDmController();
