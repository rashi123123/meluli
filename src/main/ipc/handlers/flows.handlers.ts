import * as z from "zod";
import { IPC_CHANNELS } from "@shared/ipc-channels";
import { recordingAudioPayloadSchema } from "@shared/schemas";
import type { RecordingAudioPayload } from "@shared/types";
import { MAX_FLOWS, flowConnectionSchema, flowSchema } from "@shared/flows";
import type { FlowKeyStore } from "../../services/flows/flow-key-store";
import type { FlowService } from "../../services/flows/flow.service";
import { FlowSettings } from "../../services/flows/flow-settings";
import type { SettingsService } from "../../services/settings.service";
import type { FlowPreviewChoice } from "../../services/flows/overlay-flows";
import { listInstalledApps } from "../../services/flows/installed-apps";
import { IpcRegistry } from "../registry";

const flowIdSchema = z.string().min(1).max(80).nullable();
const connectionSaveSchema = z.object({
  connection: flowConnectionSchema.omit({ consentedHost: true }),
  apiKey: z.string().max(1000).nullable().optional(),
  /** The user pressed the button that names the host. */
  consent: z.boolean()
});
const testRunSchema = z.object({ flow: flowSchema, text: z.string().trim().min(1).max(20_000) });

export function registerFlowHandlers(
  registry: IpcRegistry,
  dependencies: {
    settingsService: SettingsService;
    keys: FlowKeyStore;
    flows: FlowService;
    chooseFlow: (flowId: string | null) => boolean;
    choosePreview: (choice: FlowPreviewChoice) => Promise<void> | null;
    revert: () => Promise<void>;
    transcribeTest: (payload: RecordingAudioPayload) => Promise<string>;
  }
): void {
  const { flows } = dependencies;
  const settings = new FlowSettings(dependencies.settingsService, dependencies.keys, flows);
  const connectionId = z.string().min(1).max(80);

  registry.register(IPC_CHANNELS.flowsState, () => settings.state());

  registry.register(IPC_CHANNELS.flowsSave, (input) => {
    settings.saveFlows(z.array(flowSchema).max(MAX_FLOWS).parse(input));
    return settings.state();
  });

  registry.register(IPC_CHANNELS.flowsConnectionSave, (input) => {
    const { connection, apiKey, consent } = connectionSaveSchema.parse(input);
    const consented = settings.saveConnection(connection, apiKey, consent);
    return { consented, state: settings.state() };
  });

  registry.register(IPC_CHANNELS.flowsConnectionDelete, (input) => {
    settings.deleteConnection(connectionId.parse(input));
    return settings.state();
  });

  registry.register(IPC_CHANNELS.flowsConnectionDefault, (input) => {
    settings.makeDefault(connectionId.parse(input));
    return settings.state();
  });

  registry.register(IPC_CHANNELS.flowsConnectionTest, (input) => {
    const connection = flows.connection(connectionId.parse(input));
    if (!connection) return { ok: false, reason: "not_ready" as const, latencyMs: null, preview: null };
    return flows.testConnection(connection);
  });

  registry.register(IPC_CHANNELS.flowsTestRun, (input) => {
    const { flow, text } = testRunSchema.parse(input);
    return flows.run(flow, text, new AbortController().signal);
  });

  registry.register(IPC_CHANNELS.flowsTestDictation, (input) => dependencies.transcribeTest(recordingAudioPayloadSchema.parse(input)));
  registry.register(IPC_CHANNELS.flowsListApps, () => listInstalledApps());
  registry.register(IPC_CHANNELS.flowsChoose, (input) => dependencies.chooseFlow(flowIdSchema.parse(input)));
  registry.register(IPC_CHANNELS.flowsPreview, async (input) => {
    await dependencies.choosePreview(z.enum(["result", "original"]).parse(input));
  });
  registry.register(IPC_CHANNELS.flowsRevert, () => dependencies.revert());
}
