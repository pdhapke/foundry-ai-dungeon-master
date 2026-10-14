/** Hard deadline even when a provider ignores cooperative cancellation. Late results are discarded. */
export async function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) void work.catch(() => {});
  signal.throwIfAborted();
  let cancel: () => void = () => {};
  const stopped = new Promise<never>((_, reject) => {
    cancel = () => reject(signal.reason instanceof Error ? signal.reason : new Error("Cancelled"));
    signal.addEventListener("abort", cancel, { once: true });
  });
  try {
    return await Promise.race([work, stopped]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
