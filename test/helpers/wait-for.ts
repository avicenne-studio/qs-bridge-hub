

export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
  intervalMs = 100
) {
  const start = Date.now();
  while (true) {
    if (await condition()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
