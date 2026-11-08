// The Swift sources of the two native hosts. Every top-level file in native/host is the Node-shaped core both
// hosts share; the command-line host (meluli-js, which the conformance run uses) adds cli/, the app adds
// Electron/ and app/ (its main and the updater). A new core file goes in native/host and both hosts get it.
import { readdirSync } from "node:fs";
import { join } from "node:path";

const swiftIn = (directory) => readdirSync(directory).filter((file) => file.endsWith(".swift")).map((file) => join(directory, file));

export const cliHostSources = (root) => [...swiftIn(join(root, "native/host")), ...swiftIn(join(root, "native/host/cli"))];

export const appHostSources = (root) => [
  ...swiftIn(join(root, "native/host")),
  ...swiftIn(join(root, "native/host/Electron")),
  ...swiftIn(join(root, "native/host/app"))
];
