/** Short-lived cues never leave an idle audio device/context open. */
export async function playCue(type: "start" | "stop"): Promise<void> {
  const context = new AudioContext();
  try {
    if (context.state === "suspended") await context.resume();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = type === "start" ? 660 : 440;
    gain.gain.value = 0.0001;
    oscillator.connect(gain); gain.connect(context.destination);
    oscillator.onended = () => {
      oscillator.disconnect(); gain.disconnect();
      void context.close().catch(() => undefined);
    };
    const now = context.currentTime;
    gain.gain.exponentialRampToValueAtTime(0.08, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
    oscillator.start(now); oscillator.stop(now + 0.18);
  } catch (error) { await context.close().catch(() => undefined); throw error; }
}
