/// <reference types="vite/client" />

import type { IvritMenuBarApi } from "@shared/preload-api";

declare global {
  interface Window {
    ivritMenuBar: IvritMenuBarApi;
  }
}
