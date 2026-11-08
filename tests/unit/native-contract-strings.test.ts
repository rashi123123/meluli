/* @vitest-environment node */
// The native helpers and their TypeScript clients share plain strings. A rename on one side alone would turn a
// specific message into a generic failure, so these read the Swift sources and look for every literal TS relies on.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { holdKeyChoiceSchema } from "@shared/schemas";
import { HOLD_KEY_FAILURES } from "@main/services/hold-key.service";
import { NATIVE_INSERTABILITY, NATIVE_INSERTION_STATES } from "@main/services/insertion/native-insertion-client";
import { NATIVE_REFUSALS } from "@main/services/insertion/text-insertion.service";

const swift = (name: string) => readFileSync(new URL(`../../native/${name}`, import.meta.url), "utf8");
const quoted = (source: string, word: string) => source.includes(`"${word}"`);

describe("NativeInsertion strings", () => {
  const source = swift("NativeInsertion.swift");
  it.each([...NATIVE_INSERTION_STATES])("Swift can reply with state %s", state => {
    expect(quoted(source, state)).toBe(true);
  });
  it.each([...NATIVE_INSERTABILITY])("Swift can report insertability %s", value => {
    expect(quoted(source, value)).toBe(true);
  });
  it.each([...Object.keys(NATIVE_REFUSALS), "own_application", "target_unavailable"])("Swift can refuse with reason %s", reason => {
    expect(quoted(source, reason)).toBe(true);
  });
});

describe("HoldKey strings", () => {
  const source = swift("HoldKey.swift");
  it.each([...HOLD_KEY_FAILURES])("Swift reports the failure %s", reason => {
    expect(source).toContain(`fail("${reason}")`);
  });
  it.each(holdKeyChoiceSchema.options.filter(choice => choice !== "off"))("Swift watches the key the setting calls %s", choice => {
    expect(source).toMatch(new RegExp(`"${choice}": WatchedKey\\(`));
  });
});
