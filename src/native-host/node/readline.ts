// node:readline. Only the Anthropic SDK's local agent toolset imports it, and the app never runs that.
function unavailable(): never {
  throw new Error("node:readline is not available in the native host");
}
export function createInterface(): never { return unavailable(); }
export default { createInterface };
