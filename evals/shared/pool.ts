/**
 * Runs `fn` on every item with at most `concurrency` calls in flight, in item order as workers
 * free up. Resolves when all are done; rejects with the first error, as `Promise.all` does.
 */
export async function pool<T>(items: readonly T[], concurrency: number, fn: (item: T, index: number) => Promise<unknown>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      await fn(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
}
