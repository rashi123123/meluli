import type Anthropic from "@anthropic-ai/sdk";
import * as z from "zod";
import {
  conditionHolds,
  flowHost,
  flowStepTimeoutMs,
  flowSystemPrompt,
  isConnectionConsented,
  resolveConnection,
  wordCount,
  type Flow,
  type FlowConnection,
  type ConnectionTestResult,
  type FlowFailure,
  type FlowResult,
  type FlowRunOutcome,
  type FlowStepTrace
} from "@shared/flows";
import { isLoopbackHost } from "@shared/loopback";
import { pipelineTrace } from "../../diagnostics/pipeline-trace";
import type { FlowKeyStore } from "./flow-key-store";

const MAX_RESPONSE_CHARS = 1_000_000;
const CONNECTION_TEST_TEXT = "תבדוק בבקשה למה הבדיקות נכשלות ותסביר לי מה מצאת";

const completionSchema = z.object({
  choices: z.array(z.object({
    finish_reason: z.string().nullable().optional(),
    message: z.object({ content: z.string().nullable().optional() })
  })).min(1)
});

/** Models that accept Anthropic's server-side fallback when a request is declined. */
const FALLBACK_MODELS = /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/u;

type AnthropicSdk = typeof Anthropic;
/**
 * The SDK loads on the first Anthropic step, not at launch: it is about a third of the main bundle
 * and most people never add an Anthropic connection. In the native bundle this stays one file;
 * esbuild only defers running the module's code.
 */
let anthropicSdk: Promise<AnthropicSdk> | null = null;
const loadAnthropic = (): Promise<AnthropicSdk> => anthropicSdk ??= import("@anthropic-ai/sdk").then((module) => module.default);

function anthropicFailure(Anthropic: AnthropicSdk, error: unknown, signal: AbortSignal, timeout: AbortSignal): FlowFailure {
  if (signal.aborted) return "canceled";
  if (timeout.aborted || error instanceof Anthropic.APIConnectionTimeoutError) return "timeout";
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) return "auth";
  if (error instanceof Anthropic.NotFoundError) return "model";
  if (error instanceof Anthropic.RateLimitError) return "rate_limit";
  if (error instanceof Anthropic.APIConnectionError) return "network";
  return "provider";
}

function failureForStatus(status: number): FlowFailure {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "model";
  if (status === 429 || status === 402) return "rate_limit";
  return "provider";
}

/** Sends only the text and the step's instruction, and only to an address the user approved. */
export class FlowService {
  constructor(
    private readonly getConnections: () => readonly FlowConnection[],
    private readonly keys: Pick<FlowKeyStore, "getKey" | "hasKey">,
    private readonly request: typeof fetch = globalThis.fetch,
    private readonly timeoutFor: (chars: number) => number = flowStepTimeoutMs
  ) {}

  /** Anthropic always needs a key, a custom gateway may need none (the form says so), and local models need none. */
  private hasCredential(connection: FlowConnection): boolean {
    const host = flowHost(connection.baseUrl);
    if (host === null) return false;
    if (this.keys.hasKey(connection.id, host)) return true;
    if (connection.providerId === "anthropic") return false;
    return isLoopbackHost(host) || connection.providerId === "custom";
  }

  /** A saved connection that may be used here; none in the research profile, which never sends text out. */
  connection(id: string): FlowConnection | null {
    return this.getConnections().find((connection) => connection.id === id) ?? null;
  }

  isConnectionReady(connection: FlowConnection): boolean {
    return isConnectionConsented(connection) && this.hasCredential(connection);
  }

  /** Every model step has a connection that may receive text. Checked before anything is sent. */
  isRunnable(flow: Flow): boolean {
    const connections = this.getConnections();
    return flow.steps.every((step) => {
      if (step.kind !== "llm") return true;
      const connection = resolveConnection(connections, step.connectionId);
      return connection !== null && Boolean(step.instruction.trim()) && this.isConnectionReady(connection);
    });
  }

  async run(flow: Flow, dictation: string, signal: AbortSignal): Promise<FlowRunOutcome> {
    const trace: FlowStepTrace[] = [];
    if (!this.isRunnable(flow)) return { result: { ok: false, reason: "not_ready" }, trace };
    const connections = this.getConnections();
    pipelineTrace("flow", "start", { steps: flow.steps.length });
    let text = dictation;
    let skipNext = false;
    for (const step of flow.steps) {
      if (step.kind === "if") {
        // Conditions in a row all guard the step after them, so one that fails skips the rest too.
        if (skipNext) {
          trace.push({ stepId: step.id, kind: "if", status: "skipped_next", words: wordCount(text) });
          continue;
        }
        const holds = conditionHolds(step, text);
        trace.push({ stepId: step.id, kind: "if", status: holds ? "passed" : "skipped_next", words: wordCount(text) });
        skipNext = !holds;
        continue;
      }
      if (skipNext) {
        skipNext = false;
        trace.push({ stepId: step.id, kind: "llm", status: "skipped" });
        continue;
      }
      const connection = resolveConnection(connections, step.connectionId)!;
      const startedAt = Date.now();
      const result = await this.complete(connection, flowSystemPrompt(step.instruction, dictation), text, signal);
      if (!result.ok) {
        trace.push({ stepId: step.id, kind: "llm", status: "failed", reason: result.reason });
        pipelineTrace("flow", "end", { success: false, reason: result.reason });
        return { result, trace };
      }
      trace.push({ stepId: step.id, kind: "llm", status: "done", output: result.text, ms: Date.now() - startedAt });
      text = result.text;
    }
    pipelineTrace("flow", "end", { success: true });
    return { result: { ok: true, text }, trace };
  }

  /** Checks a connection with a fixed sentence, so no user text is involved. */
  async testConnection(connection: FlowConnection): Promise<ConnectionTestResult> {
    if (!connection.model.trim() || !this.hasCredential(connection)) return { ok: false, reason: "not_ready", latencyMs: null, preview: null };
    const startedAt = Date.now();
    const result = await this.complete(connection, flowSystemPrompt("Translate to English.", CONNECTION_TEST_TEXT), CONNECTION_TEST_TEXT, new AbortController().signal);
    return result.ok
      ? { ok: true, reason: null, latencyMs: Date.now() - startedAt, preview: result.text.slice(0, 280) }
      : { ok: false, reason: result.reason, latencyMs: null, preview: null };
  }

  private async complete(connection: FlowConnection, system: string, text: string, signal: AbortSignal): Promise<FlowResult> {
    const host = flowHost(connection.baseUrl);
    if (!host) return { ok: false, reason: "not_ready" };
    const apiKey = this.keys.getKey(connection.id, host);
    if (!apiKey && !isLoopbackHost(host) && connection.providerId !== "custom") return { ok: false, reason: "auth" };
    if (connection.providerId === "anthropic") return this.completeAnthropic(connection, apiKey, system, text, signal);
    const body = {
      model: connection.model.trim(),
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: `<text>\n${text}\n</text>` }
      ]
    };
    const timeout = AbortSignal.timeout(this.timeoutFor(text.length));
    const combined = AbortSignal.any([signal, timeout]);
    const post = (payload: unknown) => this.request(`${connection.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      // A redirect could carry the key and the text to a host the user never approved.
      redirect: "error",
      signal: combined,
      headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(payload)
    });
    try {
      let response = await post(body);
      if (response.status === 400 && /temperature/i.test((await response.clone().text()).slice(0, 2000))) {
        // Some reasoning models accept only their default temperature.
        const { temperature: _unsupported, ...withoutTemperature } = body;
        response = await post(withoutTemperature);
      }
      if (!response.ok) return { ok: false, reason: failureForStatus(response.status) };
      const raw = await response.text();
      if (raw.length > MAX_RESPONSE_CHARS) return { ok: false, reason: "provider" };
      const choice = completionSchema.parse(JSON.parse(raw)).choices[0]!;
      if (choice.finish_reason === "length") return { ok: false, reason: "truncated" };
      const output = choice.message.content?.trim();
      return output ? { ok: true, text: output } : { ok: false, reason: "empty" };
    } catch {
      if (signal.aborted) return { ok: false, reason: "canceled" };
      return { ok: false, reason: timeout.aborted ? "timeout" : "network" };
    }
  }

  /** Anthropic's Messages API, through its SDK. The same rules hold: one approved host, no redirects. */
  private async completeAnthropic(connection: FlowConnection, apiKey: string | null, system: string, text: string, signal: AbortSignal): Promise<FlowResult> {
    if (!apiKey) return { ok: false, reason: "auth" };
    const Anthropic = await loadAnthropic();
    const timeoutMs = this.timeoutFor(text.length);
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    const client = new Anthropic({
      apiKey,
      baseURL: connection.baseUrl.replace(/\/+$/, ""),
      maxRetries: 0,
      timeout: timeoutMs,
      // A redirect could carry the key and the text to a host the user never approved.
      fetch: (url, init) => this.request(url, { ...init, redirect: "error" })
    });
    const model = connection.model.trim();
    const fallback = FALLBACK_MODELS.test(model);
    const send = (effort: boolean) => client.beta.messages.create({
      model,
      max_tokens: 16_000,
      system,
      messages: [{ role: "user", content: `<text>\n${text}\n</text>` }],
      // A rewrite needs little thought; low effort keeps the paste quick.
      ...(effort ? { output_config: { effort: "low" as const } } : {}),
      ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {})
    }, { signal: combined });
    try {
      let response;
      try {
        response = await send(true);
      } catch (error) {
        // Older models refuse the effort setting; they get the request without it.
        if (!(error instanceof Anthropic.BadRequestError) || !/effort/iu.test(error.message)) throw error;
        response = await send(false);
      }
      if (response.stop_reason === "max_tokens") return { ok: false, reason: "truncated" };
      if (response.stop_reason === "refusal") return { ok: false, reason: "provider" };
      const output = response.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("").trim();
      if (output.length > MAX_RESPONSE_CHARS) return { ok: false, reason: "provider" };
      return output ? { ok: true, text: output } : { ok: false, reason: "empty" };
    } catch (error) {
      return { ok: false, reason: anthropicFailure(Anthropic, error, signal, timeout) };
    }
  }
}
