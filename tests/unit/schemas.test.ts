/* @vitest-environment node */

import { describe, expect, it } from "vitest";
import {
  appSettingsSchema,
  clipboardTextSchema,
  recordingAudioPayloadSchema,
  transcriptRecordSchema,
  youtubeSubmitInputSchema
} from "@shared/schemas";

describe("appSettingsSchema", () => {
  it("defaults to built-in terms and an empty dictionary, and rejects a dictionary past its limits", () => {
    const parsed = appSettingsSchema.parse({});
    expect(parsed.builtInTerms).toBe(true);
    expect(parsed.dictionary).toEqual([]);

    const entry = { id: "1", heard: "מלולי", written: "Meluli" };
    expect(appSettingsSchema.parse({ dictionary: [entry] }).dictionary).toEqual([entry]);
    expect(() => appSettingsSchema.parse({ dictionary: Array(501).fill(entry) })).toThrow();
    expect(() => appSettingsSchema.parse({ dictionary: [{ ...entry, heard: "א".repeat(65) }] })).toThrow();
    expect(() => appSettingsSchema.parse({ dictionary: [{ ...entry, written: "  " }] })).toThrow();
  });

  it("provides sane defaults for the MVP", () => {
    const parsed = appSettingsSchema.parse({});

    expect(parsed.onboardingCompleted).toBe(false);
    expect(parsed.theme).toBe("system");
    expect(parsed.onboarding.phase).toBe("not_started");
    expect(parsed.onboarding.surface).toBe("flow");
    expect(parsed.onboardingTracking.events).toEqual([]);
    expect(parsed.shortcut).toBe("Control+Shift+R");
    expect(parsed.overlayShortcut).toBe("Control+Shift+H");
    expect(parsed.completionNotificationsEnabled).toBe(true);
    expect(parsed.metalEnabled).toBe(true);
    expect(parsed.removeFillerWords).toBe(true);
    expect(parsed.processingTelemetry.microphone.balanced.sampleCount).toBe(0);
    expect(parsed.modelState.downloadState).toBe("missing");
  });

  it("rejects an unknown theme", () => {
    expect(() => appSettingsSchema.parse({ theme: "sepia" })).toThrow();
  });

  it("validates persisted shapes", () => {
    const parsed = appSettingsSchema.parse({
      onboardingCompleted: true,
      onboarding: {
        phase: "activated",
        surface: "workspace",
        activatedAt: 1,
        completedOptionalActions: ["recording_shortcut"],
        dismissedOptionalActions: []
      },
      onboardingTracking: {
        events: [
          {
            name: "onboarding_started",
            occurredAt: 1,
            phase: "not_started",
            step: "ready",
            sourceType: null,
            optionalAction: null
          }
        ]
      },
      shortcut: "Control+Shift+Y",
      overlayShortcut: "Control+Shift+O",
      completionNotificationsEnabled: false,
      metalEnabled: false,
      launchAtLogin: true,
      speedPreference: "accurate",
      removeFillerWords: false,
      processingTelemetry: {
        microphone: {
          balanced: { sampleCount: 1, averageSetupMs: 3_000, averageMsPerAudioSecond: 420 },
          accurate: { sampleCount: 2, averageSetupMs: 3_400, averageMsPerAudioSecond: 470 }
        },
        imported_file: {
          balanced: { sampleCount: 0, averageSetupMs: 6_500, averageMsPerAudioSecond: 180 },
          accurate: { sampleCount: 0, averageSetupMs: 7_200, averageMsPerAudioSecond: 202 }
        },
        youtube: {
          balanced: { sampleCount: 0, averageSetupMs: 6_500, averageMsPerAudioSecond: 180 },
          accurate: { sampleCount: 0, averageSetupMs: 7_200, averageMsPerAudioSecond: 202 }
        }
      },
      modelState: {
        id: "demo",
        url: "https://example.com/model.bin",
        fileName: "model.bin",
        filePath: "/tmp/model.bin",
        downloadState: "ready",
        bytesDownloaded: 10,
        totalBytes: 10
      }
    });

    expect(parsed.onboardingCompleted).toBe(true);
    expect(parsed.onboarding.phase).toBe("activated");
    expect(parsed.onboarding.completedOptionalActions).toEqual(["recording_shortcut"]);
    expect(parsed.onboardingTracking.events).toHaveLength(1);
    expect(parsed.overlayShortcut).toBe("Control+Shift+O");
    expect(parsed.completionNotificationsEnabled).toBe(false);
    expect(parsed.speedPreference).toBe("accurate");
    expect(parsed.removeFillerWords).toBe(false);
    expect(parsed.processingTelemetry.microphone.accurate.sampleCount).toBe(2);
    expect(parsed.modelState.filePath).toBe("/tmp/model.bin");
  });

  it("migrates the legacy onboarding boolean into the new activation state", () => {
    const parsed = appSettingsSchema.parse({
      onboardingCompleted: true
    });

    expect(parsed.onboardingCompleted).toBe(true);
    expect(parsed.onboarding.phase).toBe("activated");
    expect(parsed.onboarding.surface).toBe("workspace");
  });
});

describe("call suggestions", () => {
  it("stay off until the person turns them on", () => {
    expect(appSettingsSchema.parse({}).callDetection).toBe(false);
  });
});

describe("youtubeSubmitInputSchema", () => {
  it("refuses links that read differently to yt-dlp or end in a dot", () => {
    for (const url of [
      "https://example.com\\@127.0.0.1/a",
      "https://example.com\\.127.0.0.1/a",
      "https://router.local./a",
      "https://localhost./a",
      "https://printer.home.arpa/a"
    ]) {
      expect(() => youtubeSubmitInputSchema.parse({ url }), url).toThrow();
    }
  });

  it("hands on the parsed form of the link", () => {
    expect(youtubeSubmitInputSchema.parse({ url: "  https://SoundCloud.com/artist/track  " }).url)
      .toBe("https://soundcloud.com/artist/track");
  });

  it("refuses YouTube Music links", () => {
    expect(() => youtubeSubmitInputSchema.parse({ url: "https://music.youtube.com/watch?v=abc123xyz" })).toThrow();
  });

  it("accepts watch, short-link, and shorts URLs", () => {
    expect(youtubeSubmitInputSchema.parse({ url: "https://www.youtube.com/watch?v=abc123xyz" }).url).toBe(
      "https://www.youtube.com/watch?v=abc123xyz"
    );
    expect(youtubeSubmitInputSchema.parse({ url: "https://youtu.be/abc123xyz" }).url).toBe(
      "https://youtu.be/abc123xyz"
    );
    expect(youtubeSubmitInputSchema.parse({ url: "https://www.youtube.com/shorts/abc123xyz" }).url).toBe(
      "https://www.youtube.com/shorts/abc123xyz"
    );
  });

  it("rejects playlists and non-video URLs", () => {
    expect(() =>
      youtubeSubmitInputSchema.parse({ url: "https://www.youtube.com/watch?v=abc123xyz&list=PL123" })
    ).toThrow();
    expect(() => youtubeSubmitInputSchema.parse({ url: "https://www.youtube.com/channel/demo" })).toThrow();
  });

  it("takes other public sites, and leaves it to yt-dlp whether it knows them", () => {
    expect(youtubeSubmitInputSchema.parse({ url: "https://soundcloud.com/artist/track" }).url).toBe("https://soundcloud.com/artist/track");
  });

  it.each(["http://soundcloud.com/a", "file:///etc/passwd", "https://localhost/a", "https://printer.local/a", "https://127.0.0.1/a", "https://[::1]/a", "https://2130706433/a", "https://user:pw@example.com/a", "https://example.com:8443/a", "https://intranet/a"])("refuses %s", url => {
    expect(() => youtubeSubmitInputSchema.parse({ url })).toThrow();
  });
});

describe("transcriptRecordSchema", () => {
  it("keeps historical transcripts valid without language or segments", () => {
    expect(
      transcriptRecordSchema.parse({
        id: "legacy",
        createdAt: 1,
        sourceType: "microphone",
        text: "שלום"
      })
    ).toMatchObject({
      id: "legacy",
      text: "שלום"
    });
  });

  it("accepts additive segment metadata for new transcripts", () => {
    expect(
      transcriptRecordSchema.parse({
        id: "segmented",
        createdAt: 2,
        sourceType: "youtube",
        text: "שלום עולם",
        language: "he",
        segments: [{ start: 0, end: 1.5, text: "שלום עולם" }]
      }).segments
    ).toEqual([{ start: 0, end: 1.5, text: "שלום עולם" }]);
  });
});

describe("recordingAudioPayloadSchema", () => {
  it("carries the incomplete flush flag through to Main", () => {
    expect(recordingAudioPayloadSchema.parse({ pcm: [0], sampleRate: 16_000, durationMs: 1, flushIncomplete: true }).flushIncomplete).toBe(true);
  });

  it("accepts Float32Array microphone payloads for faster IPC", () => {
    const pcm = Float32Array.from([0, 0.25, -0.25]);

    expect(
      recordingAudioPayloadSchema.parse({
        pcm,
        sampleRate: 16_000,
        durationMs: 100
      }).pcm
    ).toBeInstanceOf(Float32Array);
  });
});

describe("unbounded text inputs", () => {
  it("accepts text at the limit and refuses text past it", () => {
    expect(clipboardTextSchema.safeParse("א".repeat(4_000_000)).success).toBe(true);
    expect(clipboardTextSchema.safeParse("א".repeat(4_000_001)).success).toBe(false);
  });
});
