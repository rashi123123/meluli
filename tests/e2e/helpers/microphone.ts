import type { Page } from "@playwright/test";

// Test-only Web Audio source: exercises the real analyser without opening a physical microphone.
export async function installTestMicrophone(page: Page) {
  await page.evaluate(() => {
    const fixture = { starts: 0, stops: 0 };
    Object.assign(window, { __microphoneFixture: fixture });
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: async () => {
      fixture.starts++;
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const gain = context.createGain(); gain.gain.value = .08;
      const destination = context.createMediaStreamDestination();
      oscillator.connect(gain).connect(destination); oscillator.start(); await context.resume();
      const track = destination.stream.getAudioTracks()[0];
      const stop = track.stop.bind(track);
      track.stop = () => { if (track.readyState === "ended") return; fixture.stops++; stop(); oscillator.stop(); void context.close(); };
      return destination.stream;
    } });
  });
}
