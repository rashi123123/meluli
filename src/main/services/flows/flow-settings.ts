import { MAX_FLOW_CONNECTIONS, flowHost, type Flow, type FlowConnection } from "@shared/flows";
import { isLoopbackHost } from "@shared/loopback";
import type { FlowsState } from "@shared/types";
import type { FlowKeyStore } from "./flow-key-store";
import type { FlowService } from "./flow.service";
import type { SettingsService } from "../settings.service";

/** Each app belongs to one flow: a later flow that lists a taken app loses it. */
function normalizeFlows(flows: Flow[]): Flow[] {
  const taken = new Set<string>();
  const ids = new Set<string>();
  return flows.filter((flow) => !ids.has(flow.id) && ids.add(flow.id)).map((flow) => ({
    ...flow,
    apps: flow.apps.filter((app) => !taken.has(app.bundleId) && taken.add(app.bundleId))
  }));
}

/** The saved flows and connections, and the rules for changing them: consent, keys, defaults, deletes. */
export class FlowSettings {
  constructor(
    private readonly settingsService: SettingsService,
    private readonly keys: FlowKeyStore,
    private readonly flows: FlowService
  ) {}

  state(): FlowsState {
    const settings = this.settingsService.getSettings();
    return {
      flows: settings.flows,
      keyStorageAvailable: this.keys.isAvailable(),
      connections: settings.flowConnections.map((connection) => {
        const host = flowHost(connection.baseUrl);
        return {
          ...connection,
          host,
          local: host !== null && isLoopbackHost(host),
          hasKey: host !== null && this.keys.hasKey(connection.id, host),
          ready: this.flows.isConnectionReady(connection)
        };
      })
    };
  }

  saveFlows(flows: Flow[]): void {
    this.settingsService.setSetting("flows", normalizeFlows(flows));
  }

  /** Consent belongs to the host: a new address is never sent text on an old agreement. False when not consented. */
  saveConnection(connection: Omit<FlowConnection, "consentedHost">, apiKey: string | null | undefined, consent: boolean): boolean {
    const host = flowHost(connection.baseUrl);
    if (!host) throw new Error("הכתובת צריכה להתחיל ב־https://, או להיות כתובת מקומית.");
    const connections = this.settingsService.getSettings().flowConnections;
    const previous = connections.find((c) => c.id === connection.id);
    if (!previous && connections.length >= MAX_FLOW_CONNECTIONS) throw new Error(`אפשר לשמור עד ${MAX_FLOW_CONNECTIONS} חיבורים.`);
    const consentedHost = previous?.consentedHost === host || consent || isLoopbackHost(host) ? host : null;
    if (!consentedHost) return false;
    if (apiKey?.trim()) this.keys.set(connection.id, host, apiKey);
    const saved: FlowConnection = { ...connection, consentedHost };
    const next = previous ? connections.map((c) => (c.id === saved.id ? saved : c)) : [...connections, saved];
    this.settingsService.setSetting("flowConnections", next);
    return true;
  }

  /** Steps that used the connection fall back to the default one, and its key goes with it. */
  deleteConnection(id: string): void {
    const settings = this.settingsService.getSettings();
    this.settingsService.setSetting("flowConnections", settings.flowConnections.filter((c) => c.id !== id));
    this.settingsService.setSetting("flows", settings.flows.map((flow) => ({
      ...flow,
      steps: flow.steps.map((step) => (step.kind === "llm" && step.connectionId === id ? { ...step, connectionId: null } : step))
    })));
    this.keys.clear(id);
  }

  /** The first connection is the default. */
  makeDefault(id: string): void {
    const connections = this.settingsService.getSettings().flowConnections;
    const chosen = connections.find((c) => c.id === id);
    if (chosen) this.settingsService.setSetting("flowConnections", [chosen, ...connections.filter((c) => c.id !== id)]);
  }
}
