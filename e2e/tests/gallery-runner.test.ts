import { expect, test } from "bun:test";
import { galleryBrowserLifecycle } from "../playwright/gallery-runner";

test("Gallery deadline owns a browser whose launch finishes after expiration", async () => {
  const lifecycle = galleryBrowserLifecycle(5);
  let finishLaunch!: (browser: { close(): Promise<void> }) => void;
  let closeCalls = 0;
  const launched = lifecycle.launch(
    () =>
      new Promise<{ close(): Promise<void> }>((resolve) => {
        finishLaunch = resolve;
      }),
  );
  await new Promise<void>((resolve) =>
    lifecycle.signal.addEventListener("abort", () => resolve(), { once: true }),
  );
  expect(lifecycle.expired).toBe(true);
  expect(() => lifecycle.launch(async () => ({ close: async () => {} }))).toThrow();
  finishLaunch({
    close: async () => {
      closeCalls += 1;
    },
  });
  await launched;
  await Promise.all([lifecycle.close(), lifecycle.close()]);
  expect(closeCalls).toBe(1);
});

test("Gallery normal cleanup waits for browser closure and retains close failures", async () => {
  const lifecycle = galleryBrowserLifecycle(5_000);
  let releaseClose!: () => void;
  let closeStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    closeStarted = resolve;
  });
  let terminalAllowed = false;
  await lifecycle.launch(async () => ({
    close: async () => {
      closeStarted();
      await new Promise<void>((resolve) => {
        releaseClose = resolve;
      });
      throw new Error("synthetic lifecycle unit failure");
    },
  }));
  const closed = lifecycle.close().finally(() => {
    terminalAllowed = true;
  });
  await started;
  expect(terminalAllowed).toBe(false);
  releaseClose();
  await expect(closed).rejects.toThrow("synthetic lifecycle unit failure");
  expect(lifecycle.expired).toBe(false);
  expect(terminalAllowed).toBe(true);
});

test("Gallery deadline remains armed while normal browser closure is pending", async () => {
  const lifecycle = galleryBrowserLifecycle(5);
  let releaseClose!: () => void;
  let closeCalls = 0;
  await lifecycle.launch(async () => ({
    close: async () => {
      closeCalls += 1;
      await new Promise<void>((resolve) => {
        releaseClose = resolve;
      });
    },
  }));
  const closed = lifecycle.close();
  await new Promise<void>((resolve) =>
    lifecycle.signal.addEventListener("abort", () => resolve(), { once: true }),
  );
  expect(lifecycle.expired).toBe(true);
  releaseClose();
  await closed;
  expect(closeCalls).toBe(1);
});
