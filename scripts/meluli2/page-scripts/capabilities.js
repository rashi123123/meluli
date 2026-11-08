// Page script (MELULI_NATIVE_PAGE_SCRIPT): what the page can use, without opening the microphone.
return {
  secure: window.isSecureContext,
  origin: location.origin,
  mediaDevices: typeof navigator.mediaDevices?.getUserMedia,
  audioWorklet: typeof AudioWorkletNode,
  audioContext: typeof AudioContext,
  webgl: Boolean(document.createElement("canvas").getContext("webgl2")),
  devices: navigator.mediaDevices ? (await navigator.mediaDevices.enumerateDevices()).map((device) => device.kind) : null,
  permissions: await navigator.permissions?.query({ name: "microphone" }).then((status) => status.state, (error) => String(error)),
  storage: (() => { try { localStorage.setItem("probe", "1"); localStorage.removeItem("probe"); return "ok"; } catch (error) { return String(error); } })(),
  cssHas: CSS.supports("selector(:has(a))"),
  zoom: CSS.supports("zoom", "1.1")
};
