/// <reference lib="dom" />
/// <reference lib="dom.asynciterable" />
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, _electron as electron } from "@playwright/test";

test("built AudioWorklet loads under the app CSP, captures samples and acknowledges its final flush", async () => {
  const profile = mkdtempSync(join(tmpdir(), "meluli-audio-module-"));
  const assets = readdirSync("out/renderer/assets");
  const module = assets.find(name => /^audio-worklet-.*\.js$/.test(name));
  expect(module, "The worklet must be emitted as compiled JavaScript").toBeDefined();
  const app = await electron.launch({ args: [".", "--autoplay-policy=no-user-gesture-required"],
    env: { ...process.env, IVRIT_E2E_MOCK: "1", MELULI_USER_DATA: profile } });
  try {
    const page = await app.firstWindow();
    await page.waitForURL(/index\.html/);
    await page.waitForLoadState("domcontentloaded");
    const result = await page.evaluate(async module => {
      const context = new AudioContext({ sampleRate: 16000 });
      const oscillator = context.createOscillator();
      try {
        await context.audioWorklet.addModule(new URL(`./assets/${module}`, location.href).href);
        const recorder = new AudioWorkletNode(context, "ivrit-recorder-processor");
        let samples = 0;
        let stopping = false;
        const flushed = new Promise<number>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("Worklet did not flush")), 5000);
          recorder.port.onmessage = event => {
            if (event.data instanceof Float32Array) {
              samples += event.data.length;
              // Native audio device startup is asynchronous. Stop after real
              // capture, rather than assuming it started within 300 ms.
              if (samples > 2048 && !stopping) {
                stopping = true;
                oscillator.disconnect();
                recorder.port.postMessage({ type: "stop" });
              }
            }
            else if (event.data?.type === "flushed") { clearTimeout(timeout); resolve(samples); }
          };
        });
        oscillator.connect(recorder); recorder.connect(context.destination);
        oscillator.start(); await context.resume();
        return await flushed;
      } finally { try { oscillator.stop(); } catch { /* Not started if module loading failed. */ } await context.close(); }
    }, module!);
    expect(result).toBeGreaterThan(2048);
  } finally { await app.close(); rmSync(profile, { recursive: true, force: true }); }
});
