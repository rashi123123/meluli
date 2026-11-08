/* @vitest-environment node */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ORIGINAL_TOKEN, assignApp, conditionHolds, flowForApp, flowHost, flowStepTimeoutMs, flowSystemPrompt,
  flowsSettingSchema, isConnectionConsented, resolveConnection, type Flow, type FlowConnection
} from "@shared/flows";
import { FlowService } from "@main/services/flows/flow.service";
import { FlowKeyStore } from "@main/services/flows/flow-key-store";
import { registerFlowHandlers } from "@main/ipc/handlers/flows.handlers";
import type { IpcRegistry } from "@main/ipc/registry";
import { IPC_CHANNELS } from "@shared/ipc-channels";

const connection = (patch: Partial<FlowConnection> = {}): FlowConnection => ({
  id: "c1", providerId: "openrouter", baseUrl: "https://openrouter.ai/api/v1", model: "m", consentedHost: "openrouter.ai", ...patch
});
const flow = (patch: Partial<Flow> = {}): Flow => ({
  id: "f1", name: "פעולה", icon: "wand", apps: [], delivery: "paste", enabled: true,
  steps: [{ id: "s1", kind: "llm", instruction: "translate", connectionId: null }], ...patch
});
const keys = (value: string | null = "sk-test") => ({ getKey: vi.fn(() => value), hasKey: vi.fn(() => value !== null) });
const reply = (content: string | null, finish = "stop", status = 200) =>
  new Response(JSON.stringify({ choices: [{ finish_reason: finish, message: { content } }] }), { status });

describe("flow model", () => {
  it("binds a connection to https hosts and loopback http only", () => {
    expect(flowHost("https://api.groq.com/openai/v1")).toBe("api.groq.com");
    expect(flowHost("http://localhost:11434/v1")).toBe("localhost:11434");
    expect(flowHost("http://example.com/v1")).toBeNull();
    expect(flowHost("https://user:pw@example.com/v1")).toBeNull();
    expect(flowHost("https://example.com/v1?x=1")).toBeNull();
    expect(flowHost("not a url")).toBeNull();
  });

  it("needs a fresh consent when the address moves to another host", () => {
    expect(isConnectionConsented(connection())).toBe(true);
    expect(isConnectionConsented(connection({ baseUrl: "https://evil.example/v1" }))).toBe(false);
    expect(isConnectionConsented(connection({ model: " " }))).toBe(false);
  });

  it("treats a step without a connection as the first connection", () => {
    const list = [connection(), connection({ id: "c2" })];
    expect(resolveConnection(list, null)?.id).toBe("c1");
    expect(resolveConnection(list, "c2")?.id).toBe("c2");
    expect(resolveConnection(list, "gone")).toBeNull();
  });

  it("moves an app from the flow that held it", () => {
    const mail = { bundleId: "com.apple.mail", name: "Mail" };
    const flows = [flow({ id: "a", name: "מייל", apps: [mail] }), flow({ id: "b", name: "אחר" })];
    const { flows: next, movedFrom } = assignApp(flows, "b", mail);
    expect(movedFrom).toBe("מייל");
    expect(next[0]!.apps).toEqual([]);
    expect(next[1]!.apps).toEqual([mail]);
  });

  it("routes an app only to an enabled flow", () => {
    const app = { bundleId: "com.tinyspeck.slackmacgap", name: "Slack" };
    expect(flowForApp([flow({ apps: [app], enabled: false })], app.bundleId)).toBeNull();
    expect(flowForApp([flow({ apps: [app] })], app.bundleId)?.id).toBe("f1");
    expect(flowForApp([flow({ apps: [app] })], null)).toBeNull();
  });

  it("counts words for conditions and gives long text more time up to a cap", () => {
    expect(conditionHolds({ id: "i", kind: "if", op: "min", words: 3 }, "שלום  עולם יפה")).toBe(true);
    expect(conditionHolds({ id: "i", kind: "if", op: "max", words: 2 }, "שלום עולם יפה")).toBe(false);
    expect(flowStepTimeoutMs(0)).toBe(15_000);
    expect(flowStepTimeoutMs(1_000)).toBe(25_000);
    expect(flowStepTimeoutMs(10_000_000)).toBe(180_000);
  });

  it("puts the original dictation where the instruction asks for it", () => {
    const prompt = flowSystemPrompt(`Shorten it. Context: ${ORIGINAL_TOKEN}`, "ההכתבה");
    expect(prompt).toContain("<original_dictation>\nההכתבה\n</original_dictation>");
    expect(prompt).not.toContain(ORIGINAL_TOKEN);
  });

  it("drops one broken stored flow instead of all of them", () => {
    expect(flowsSettingSchema.parse([flow(), { id: "bad" }])).toHaveLength(1);
  });
});

describe("FlowService", () => {
  it("sends nothing when a step's connection is not consented", async () => {
    const request = vi.fn();
    const service = new FlowService(() => [connection({ consentedHost: null })], keys(), request);
    const outcome = await service.run(flow(), "שלום", new AbortController().signal);
    expect(outcome.result).toEqual({ ok: false, reason: "not_ready" });
    expect(request).not.toHaveBeenCalled();
  });

  it("refuses redirects and sends the key only to the consented address", async () => {
    const request = vi.fn(async () => reply("Hello"));
    const service = new FlowService(() => [connection()], keys(), request);
    const outcome = await service.run(flow(), "שלום", new AbortController().signal);
    expect(outcome.result).toEqual({ ok: true, text: "Hello" });
    const [url, init] = request.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init.redirect).toBe("error");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(String(init.body)) as { messages: { role: string; content: string }[] };
    expect(body.messages[1]!.content).toBe("<text>\nשלום\n</text>");
  });

  it("skips only the step after a failed condition and feeds each step the previous output", async () => {
    const request = vi.fn(async () => reply("second"));
    const service = new FlowService(() => [connection()], keys(), request);
    const outcome = await service.run(flow({ steps: [
      { id: "if1", kind: "if", op: "min", words: 5 },
      { id: "s1", kind: "llm", instruction: "first", connectionId: null },
      { id: "s2", kind: "llm", instruction: `second ${ORIGINAL_TOKEN}`, connectionId: null }
    ] }), "קצר", new AbortController().signal);
    expect(outcome.trace.map(t => t.status)).toEqual(["skipped_next", "skipped", "done"]);
    expect(request).toHaveBeenCalledOnce();
    const body = JSON.parse(String((request.mock.calls[0]! as unknown as [string, RequestInit])[1].body)) as { messages: { content: string }[] };
    expect(body.messages[0]!.content).toContain("<original_dictation>\nקצר\n</original_dictation>");
    expect(outcome.result).toEqual({ ok: true, text: "second" });
  });

  it("runs a custom gateway saved without a key, and sends no key to it", async () => {
    const request = vi.fn(async () => reply("ok"));
    const gateway = connection({ providerId: "custom", baseUrl: "https://gateway.example.com/v1", consentedHost: "gateway.example.com" });
    const outcome = await new FlowService(() => [gateway], keys(null), request).run(flow(), "שלום", new AbortController().signal);
    expect(outcome.result).toEqual({ ok: true, text: "ok" });
    const init = (request.mock.calls[0]! as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("still needs a key for a hosted provider", async () => {
    const request = vi.fn();
    const outcome = await new FlowService(() => [connection()], keys(null), request as never).run(flow(), "שלום", new AbortController().signal);
    expect(outcome.result).toEqual({ ok: false, reason: "not_ready" });
    expect(request).not.toHaveBeenCalled();
  });

  it("lets conditions in a row all guard the step after them", async () => {
    const request = vi.fn(async () => reply("rewritten"));
    const service = new FlowService(() => [connection()], keys(), request);
    const outcome = await service.run(flow({ steps: [
      { id: "if1", kind: "if", op: "min", words: 5 },
      { id: "if2", kind: "if", op: "max", words: 50 },
      { id: "s1", kind: "llm", instruction: "rewrite", connectionId: null }
    ] }), "רק שלוש מילים", new AbortController().signal);
    expect(outcome.trace.map(t => t.status)).toEqual(["skipped_next", "skipped_next", "skipped"]);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([[401, "auth"], [404, "model"], [429, "rate_limit"], [500, "provider"]] as const)("maps HTTP %i to %s", async (status, reason) => {
    const service = new FlowService(() => [connection()], keys(), vi.fn(async () => new Response("no", { status })));
    expect((await service.run(flow(), "שלום", new AbortController().signal)).result).toEqual({ ok: false, reason });
  });

  it("retries once without a temperature the model refuses", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(new Response("temperature is not supported", { status: 400 }))
      .mockResolvedValueOnce(reply("ok"));
    const service = new FlowService(() => [connection()], keys(), request);
    expect((await service.run(flow(), "שלום", new AbortController().signal)).result).toEqual({ ok: true, text: "ok" });
    expect(JSON.parse(String((request.mock.calls[1]! as [string, RequestInit])[1].body))).not.toHaveProperty("temperature");
  });

  it("reports a cut-off or empty answer instead of pasting it", async () => {
    const cut = new FlowService(() => [connection()], keys(), vi.fn(async () => reply("partial", "length")));
    expect((await cut.run(flow(), "שלום", new AbortController().signal)).result).toEqual({ ok: false, reason: "truncated" });
    const empty = new FlowService(() => [connection()], keys(), vi.fn(async () => reply("  ")));
    expect((await empty.run(flow(), "שלום", new AbortController().signal)).result).toEqual({ ok: false, reason: "empty" });
  });

  it("tells a cancel apart from a timeout", async () => {
    const hang = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    const canceled = new AbortController();
    const service = new FlowService(() => [connection()], keys(), hang as never);
    const pending = service.run(flow(), "שלום", canceled.signal);
    canceled.abort();
    expect((await pending).result).toEqual({ ok: false, reason: "canceled" });
    const slow = new FlowService(() => [connection()], keys(), hang as never, () => 10);
    expect((await slow.run(flow(), "שלום", new AbortController().signal)).result).toEqual({ ok: false, reason: "timeout" });
  });

  it("runs a local model without a key", async () => {
    const local = connection({ providerId: "ollama", baseUrl: "http://localhost:11434/v1", consentedHost: "localhost:11434" });
    const request = vi.fn(async () => reply("מקומי"));
    const service = new FlowService(() => [local], keys(null), request);
    expect((await service.run(flow(), "שלום", new AbortController().signal)).result).toEqual({ ok: true, text: "מקומי" });
    expect(((request.mock.calls[0]! as unknown as [string, RequestInit])[1].headers as Record<string, string>).Authorization).toBeUndefined();
  });
});

describe("FlowKeyStore", () => {
  let directory: string | null = null;
  afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); directory = null; });
  const encryption = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`),
    decryptString: (value: Buffer) => value.toString().replace(/^enc:/, "")
  };

  it("keeps a key only for the host it was entered for, encrypted on disk", () => {
    directory = mkdtempSync(join(tmpdir(), "meluli-flow-keys-"));
    const file = join(directory, "flow-keys.json");
    const store = new FlowKeyStore(file, encryption);
    store.set("c1", "openrouter.ai", "sk-secret");
    expect(store.getKey("c1", "openrouter.ai")).toBe("sk-secret");
    expect(store.getKey("c1", "evil.example")).toBeNull();
    expect(readFileSync(file, "utf8")).not.toContain("sk-secret");
    store.retain(["other"]);
    expect(store.hasKey("c1", "openrouter.ai")).toBe(false);
  });

  it("refuses to store a key it cannot encrypt", () => {
    directory = mkdtempSync(join(tmpdir(), "meluli-flow-keys-"));
    const store = new FlowKeyStore(join(directory, "k.json"), { ...encryption, isEncryptionAvailable: () => false });
    expect(() => store.set("c1", "openrouter.ai", "sk-secret")).toThrow();
  });
});

describe("FlowService with Anthropic", () => {
  const claude = connection({ id: "c2", providerId: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-opus-5-5", consentedHost: "api.anthropic.com" });
  const message = (text: string, stopReason = "end_turn", status = 200) => new Response(JSON.stringify({
    id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: stopReason, stop_sequence: null,
    content: [{ type: "text", text }], usage: { input_tokens: 1, output_tokens: 1 }
  }), { status, headers: { "content-type": "application/json" } });
  const headerOf = (init: RequestInit, name: string) => new Headers(init.headers).get(name);

  it("calls the Messages API with the key, no redirects and no temperature", async () => {
    const request = vi.fn(async (..._args: unknown[]) => message("Hello"));
    const service = new FlowService(() => [claude], keys("sk-ant-test"), request as never);
    const outcome = await service.run(flow(), "שלום", new AbortController().signal);
    expect(outcome.result).toEqual({ ok: true, text: "Hello" });
    const [url, init] = request.mock.calls[0]! as [string | URL, RequestInit];
    expect(String(url)).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/messages/);
    expect(init.redirect).toBe("error");
    expect(headerOf(init, "authorization")).toBe("Bearer sk-ant-test");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.temperature).toBeUndefined();
    expect(String(body.system)).toContain("translate");
    expect(body.fallbacks).toBe("default");
  });

  it("maps the stop reason and errors to flow failures", async () => {
    const cut = new FlowService(() => [claude], keys(), vi.fn(async () => message("partial", "max_tokens")) as never);
    expect((await cut.run(flow(), "שלום", new AbortController().signal)).result).toEqual({ ok: false, reason: "truncated" });
    const denied = new FlowService(() => [claude], keys(), vi.fn(async () => new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "bad key" } }),
      { status: 401, headers: { "content-type": "application/json" } })) as never);
    expect((await denied.run(flow(), "שלום", new AbortController().signal)).result).toEqual({ ok: false, reason: "auth" });
  });

  it("needs a key for Anthropic", async () => {
    const request = vi.fn();
    const service = new FlowService(() => [claude], keys(null), request as never);
    expect((await service.run(flow(), "שלום", new AbortController().signal)).result).toEqual({ ok: false, reason: "not_ready" });
    expect(request).not.toHaveBeenCalled();
  });
});

describe("connection test through IPC", () => {
  // The container hands FlowService an empty connection list in the research profile; the test button must obey it.
  const testHandler = (flows: FlowService) => {
    const handlers = new Map<string, (input: unknown) => unknown>();
    const registry = { register: (channel: string, handler: (input: unknown) => unknown) => handlers.set(channel, handler) };
    registerFlowHandlers(registry as unknown as IpcRegistry, {
      settingsService: { getSettings: () => ({ flowConnections: [connection()] }) } as never, keys: keys() as never, flows,
      chooseFlow: vi.fn(), choosePreview: vi.fn(), revert: vi.fn(), transcribeTest: vi.fn()
    });
    return (id: string) => Promise.resolve(handlers.get(IPC_CHANNELS.flowsConnectionTest)!(id));
  };

  it("answers not ready and sends nothing when the research profile hides every connection", async () => {
    const request = vi.fn(async () => reply("Hello"));
    const result = await testHandler(new FlowService(() => [], keys(), request))("c1");
    expect(result).toEqual({ ok: false, reason: "not_ready", latencyMs: null, preview: null });
    expect(request).not.toHaveBeenCalled();
  });

  it("reaches the provider for a stored connection otherwise", async () => {
    const request = vi.fn(async () => reply("Hello"));
    const result = await testHandler(new FlowService(() => [connection()], keys(), request))("c1");
    expect(result).toMatchObject({ ok: true, preview: "Hello" });
    expect(request).toHaveBeenCalledOnce();
  });
});
