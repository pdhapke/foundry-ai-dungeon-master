/* eslint-disable @typescript-eslint/no-explicit-any */
declare const Hooks: {
  once(event: string, callback: (...args: any[]) => unknown): void;
  on(event: string, callback: (...args: any[]) => unknown): number;
};

declare const game: {
  user: { id: string; isGM: boolean; name?: string; active?: boolean };
  world?: { id?: string };
  paused?: boolean;
  collections: Map<string, { get(id: string): { toObject(): Record<string, unknown> } | undefined }>;
  socket: {
    emit(
      event: string,
      payload: Record<string, unknown>,
      acknowledgement: (response: unknown) => void,
    ): void;
  };
  settings: {
    register(moduleId: string, key: string, options: Record<string, unknown>): void;
    get(moduleId: string, key: string): unknown;
    set(moduleId: string, key: string, value: unknown): Promise<unknown>;
  };
  keybindings: {
    register(moduleId: string, key: string, options: Record<string, unknown>): void;
  };
};

declare const canvas:
  | {
      scene?: { id: string };
      tokens?: {
        controlled?: Array<{ document?: { id?: string; actorId?: string }; id?: string }>;
        placeables?: Array<{ id?: string; isTargeted?: boolean }>;
      };
    }
  | undefined;

declare const ui: {
  notifications: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
};

declare const CONFIG: Record<string, { documentClass?: { create(data: Record<string, unknown>, options: { keepId: true }): Promise<{ toObject(): Record<string, unknown> } | undefined> } } | undefined>;

declare const foundry: {
  applications: {
    api: {
      ApplicationV2: new (options?: Record<string, unknown>) => {
        render(options?: { force?: boolean }): unknown;
        close(options?: Record<string, unknown>): Promise<void>;
        element: HTMLElement;
      };
      HandlebarsApplicationMixin<T>(base: T): T;
    };
  };
  utils?: { randomID?: (length?: number) => string };
};
