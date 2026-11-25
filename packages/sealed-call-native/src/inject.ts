import type { HostMessage } from "./protocol";

/**
 * Builds the JavaScript that delivers one host message into the page.
 *
 * Messages can be sent before the page's bridge has initialised — the user may hit
 * "unlock" while the call page is still booting — so anything that arrives early is
 * queued on `window` and drained by the page bridge when it installs itself. Without the
 * queue, the first key would be silently lost and the tile would stay locked forever.
 *
 * The trailing `true;` matters: `injectJavaScript` on iOS reports an error if the last
 * expression evaluates to something it cannot serialise.
 */
export function injectHostMessage(message: HostMessage): string {
  const payload = JSON.stringify(JSON.stringify(message));
  return `(function () {
  try {
    var raw = ${payload};
    var bridge = window.__sealedCall;
    if (bridge && typeof bridge.receive === "function") { bridge.receive(raw); }
    else { (window.__sealedCallQueue = window.__sealedCallQueue || []).push(raw); }
  } catch (error) {}
})(); true;`;
}

/**
 * Injected before the page's own scripts run, so `window.ReactNativeWebView` is already
 * there when the call page's bridge initialises and the page can tell it is hosted.
 */
export const BOOTSTRAP_SCRIPT = `(function () {
  window.__sealedCallHosted = true;
  window.__sealedCallQueue = window.__sealedCallQueue || [];
})(); true;`;
