import type { ReactNode } from "react";
import { providerPreset, type Flow, type FlowFailure, MAX_FLOW_NAME_CHARS } from "@shared/flows";
import type { FlowsState } from "@shared/types";

export type ConnectionView = FlowsState["connections"][number];

/** What went wrong, in words that say what to do next. */
export function failureCopy(reason: FlowFailure | null, local = false): string {
  switch (reason) {
    case "not_ready": return "החיבור לא מוכן: חסר מפתח, מודל או אישור.";
    case "auth": return "הספק דחה את המפתח. כדאי לבדוק שהועתק במלואו.";
    case "model": return "הספק לא מכיר את המודל הזה. כדאי לבדוק את השם.";
    case "rate_limit": return "הספק הגביל את הקצב או שנגמרה המכסה. אפשר לנסות שוב בעוד רגע.";
    case "network": return local ? "אין תשובה מהכתובת. האם Ollama פתוח?" : "אין חיבור לספק. כדאי לבדוק את האינטרנט ואת הכתובת.";
    case "timeout": return "לא הגיעה תשובה בזמן.";
    case "truncated": return "התשובה נקטעה באמצע.";
    case "empty": return "המודל החזיר תשובה ריקה.";
    case "canceled": return "בוטל.";
    case "provider":
    default: return "הספק החזיר שגיאה.";
  }
}

export const connectionLabel = (connection: ConnectionView): string =>
  connection.providerId === "custom" ? connection.host ?? providerPreset("custom").label : providerPreset(connection.providerId).label;

let counter = 0;
export const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

/** The schema refuses an empty name; a half-typed one is saved under a placeholder. */
export const forSave = (flow: Flow): Flow => ({ ...flow, name: flow.name.trim().slice(0, MAX_FLOW_NAME_CHARS) || "פעולה בלי שם" });

/** Hosts a flow's text goes to. Local connections and steps without a connection add none. */
function flowHosts(flow: Flow, connections: ConnectionView[]): string[] {
  const hosts = new Set<string>();
  for (const step of flow.steps) {
    if (step.kind !== "llm") continue;
    const connection = (step.connectionId ? connections.find(c => c.id === step.connectionId) : connections[0]) ?? null;
    if (connection?.host && !connection.local) hosts.add(connection.host);
  }
  return [...hosts];
}

export function destination(flow: Flow, connections: ConnectionView[]): ReactNode {
  const hosts = flowHosts(flow, connections);
  return hosts.length ? <>נשלח אל <bdi dir="ltr">{hosts.join(", ")}</bdi></> : "נשאר במחשב";
}
