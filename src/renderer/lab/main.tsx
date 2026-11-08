import React from "react";
import ReactDOM from "react-dom/client";
import { installMockBridge, logLabCall } from "./mock-bridge";
import { enableSchemeOverride } from "./scheme";
import "../globals.css";
import "./lab.css";

const root = document.getElementById("root")!;

// Inside Electron the real bridge exists, and lab clicks would reach real settings and transcripts.
if ("ivritMenuBar" in window || !import.meta.env.DEV) {
  root.textContent = "The component lab runs only in a plain browser, from `pnpm lab`.";
} else {
  installMockBridge();
  // Stories such as the onboarding microphone check would otherwise open the real microphone.
  if (navigator.mediaDevices) {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      value: (constraints: MediaStreamConstraints) => {
        logLabCall("blocked.getUserMedia", [constraints]);
        return Promise.reject(new DOMException("The component lab never opens the microphone.", "NotAllowedError"));
      }
    });
  }
  document.documentElement.dataset.windowMode = "lab";
  enableSchemeOverride();
  void import("./LabApp").then(({ LabApp }) => ReactDOM.createRoot(root).render(<React.StrictMode><LabApp /></React.StrictMode>));
}
