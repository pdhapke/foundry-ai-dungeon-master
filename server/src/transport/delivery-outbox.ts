import { randomUUID } from "node:crypto";

import type { AiDmServerDelivery } from "@foundry-ai-dungeon-master/shared";

import type { AiDmDeliverySink } from "../orchestration/index.js";
import type { AiDmOperationalStore } from "../storage/index.js";

export interface AiDmDeliverySender {
  sendDelivery(delivery: AiDmServerDelivery): number;
}

export class AiDmDeliveryOutboxPump implements AiDmDeliverySink {
  readonly #workerId = `outbox-${randomUUID()}`;
  #timer: NodeJS.Timeout | null = null;
  #running = false;

  constructor(
    private readonly store: AiDmOperationalStore,
    private readonly sender: AiDmDeliverySender,
    private readonly now: () => Date = () => new Date(),
  ) {}

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.flush(), 2_000);
    this.#timer.unref();
    void this.flush();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  deliver(): void {
    this.flush();
  }

  flush(): void {
    if (this.#running) return;
    this.#running = true;
    try {
      const now = this.now();
      const leased = this.store.leaseDeliveries({
        workerId: this.#workerId,
        now: now.toISOString(),
        leaseUntil: new Date(now.getTime() + 15_000).toISOString(),
        limit: 100,
      });
      for (const item of leased) {
        if (this.sender.sendDelivery(item.delivery) > 0) {
          this.store.acknowledgeDelivery(
            item.delivery.deliveryId,
            this.#workerId,
            this.now().toISOString(),
          );
        } else {
          const failedAt = this.now();
          this.store.failDelivery(
            item.delivery.deliveryId,
            this.#workerId,
            failedAt.toISOString(),
            "RECIPIENT_OFFLINE",
            new Date(failedAt.getTime() + 5_000).toISOString(),
          );
        }
      }
    } finally {
      this.#running = false;
    }
  }
}
