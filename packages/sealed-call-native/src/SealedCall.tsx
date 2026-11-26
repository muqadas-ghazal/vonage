import React, { useCallback, useEffect, useMemo, useRef } from "react";
import { AppState, Platform, StyleSheet, View } from "react-native";
import { WebView, type WebViewProps } from "react-native-webview";

/**
 * react-native-webview 14 declares `WebView` as a class component in a way React 19's JSX
 * types collapse to `never` props, so every prop below would be reported as an error. The
 * props we pass are all valid `WebViewProps`; narrowing here keeps them typed against that
 * interface instead of loosening the component to `any`.
 */
const Web = WebView as unknown as React.ComponentClass<
  WebViewProps & { ref?: React.Ref<WebView> }
>;

import { BOOTSTRAP_SCRIPT, injectHostMessage } from "./inject";
import {
  prepareAudio,
  releaseAudio,
  startKeepAlive,
  stopKeepAlive,
  type KeepAliveOptions,
} from "./keepAlive";
import { PAGE_STATUS_IN_CALL, parsePageMessage, type HostMessage } from "./protocol";
import type { SealedCallController } from "./useSealedCall";

/** What the call surface needs to know, injected before its script runs. */
export type CallConfig = {
  /** Origin of the backend that mints Vonage credentials. */
  apiBase: string;
  room: string;
  name: string;
};

/**
 * Where the call surface comes from.
 *
 * `url` loads it from a server — simplest, and what a browser does. `file` loads the copy
 * bundled into the app, which is what makes the app self-contained: no deployed page, and
 * nothing for App Review to read as a web wrapper. The backend is still needed for tokens.
 */
export type SealedCallSource =
  | { kind: "url"; url: string }
  | { kind: "file"; uri: string };

export type SealedCallProps = {
  /**
   * The call page, over **https**. `getUserMedia` needs a secure context, so a
   * `source={{ html }}` string (which loads as `about:blank`) and a bundled `file://`
   * page both fail to get the camera.
   */
  url?: string;
  /** Takes precedence over `url`. */
  source?: SealedCallSource;
  config: CallConfig;
  call: SealedCallController;
  /** Keeps audio alive in the background. Pass `false` to opt out. */
  keepAlive?: KeepAliveOptions | false;
  /** Extra request headers for the initial page load. Ignored for a bundled surface. */
  headers?: Record<string, string>;
  /** Escape hatch for anything else you need on the underlying WebView. */
  webViewProps?: Partial<WebViewProps>;
  style?: WebViewProps["style"];
  onError?: (message: string) => void;
};

/**
 * Hosts the call page and wires it to the native shell.
 *
 * Vonage runs the call inside the page exactly as it does on the web — signalling,
 * negotiation, codecs, reconnection. This component contributes two things the page cannot
 * do for itself: the OS permissions and background audio that keep a mobile call alive,
 * and a message channel so the encryption UI can be native.
 *
 * Keep it mounted for the life of the meeting. Unmounting tears down the peer connection,
 * and remounting is a rejoin, not a resume.
 */
export function SealedCall({
  url,
  source,
  config,
  headers,
  call,
  keepAlive = {},
  webViewProps,
  style,
  onError,
}: SealedCallProps) {
  const webView = useRef<WebView | null>(null);
  // The config rides in the URL fragment as well as through injection, because
  // `injectedJavaScriptBeforeContentLoaded` is not guaranteed to run before the page's
  // own scripts on Android — it races them. A fragment is part of the load itself, so it
  // cannot lose. The fragment never leaves the device: browsers do not send it to servers.
  const resolved: SealedCallSource = useMemo(() => {
    const fragment = new URLSearchParams({
      apiBase: config.apiBase,
      room: config.room,
      name: config.name,
    }).toString();
    if (source) {
      return source.kind === "url"
        ? { kind: "url", url: withFragment(source.url, fragment) }
        : { kind: "file", uri: withFragment(source.uri, fragment) };
    }
    return { kind: "url", url: withFragment(url ?? "", fragment) };
  }, [source, url, config]);
  const origin = useMemo(
    () => (resolved.kind === "url" ? safeOrigin(resolved.url) : "*"),
    [resolved],
  );
  // The surface reads window.__callConfig, so it has to exist before its own script
  // runs. Injected as a JSON string rather than interpolated object literal: a room name
  // with a quote in it would otherwise break the injected script.
  const bootstrap = useMemo(
    () =>
      `${BOOTSTRAP_SCRIPT}\n(function () { try { window.__callConfig = JSON.parse(${JSON.stringify(
        JSON.stringify(config),
      )}); } catch (error) {} })(); true;`,
    [config],
  );

  const send = useCallback((message: HostMessage) => {
    webView.current?.injectJavaScript(injectHostMessage(message));
  }, []);

  const { internal } = call;

  useEffect(() => {
    internal.bind(send);
    return () => internal.bind(null);
  }, [internal, send]);

  const inCall = call.page.status === PAGE_STATUS_IN_CALL;
  const keepAliveStarted = useRef(false);
  const audioPrepared = useRef(false);

  useEffect(() => {
    if (keepAlive === false || !inCall || keepAliveStarted.current) return;
    // Deliberately not on mount. See PAGE_STATUS_IN_CALL: a microphone-typed foreground
    // service running before the WebView acquires the camera makes Android refuse it.
    keepAliveStarted.current = true;
    void startKeepAlive(keepAlive);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inCall]);

  useEffect(() => {
    // Voice-call mode is applied only after the page is publishing. Setting
    // MODE_IN_COMMUNICATION first makes the WebView's getUserMedia fail with
    // NotReadableError: permission is granted, and the mic still will not open.
    console.log("[sealed-call] voice-call mode deferred until the microphone is open");
    return () => {
      void stopKeepAlive();
      void releaseAudio();
    };
  }, []);

  useEffect(() => {
    if (!inCall || audioPrepared.current) return;
    audioPrepared.current = true;
    console.log("[sealed-call] call is publishing; setting voice-call mode now");
    void prepareAudio().then((ok) => {
      console.log(
        `[sealed-call] prepareAudio ${ok ? "applied" : "skipped or failed (no native module, or Android rejected it)"}`,
      );
    });
  }, [inCall]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      // Coming back from the background: the camera may have been ended by the OS and
      // needs re-acquiring, and a peer may have locked or unlocked while we were away.
      if (next === "active") call.resume();
    });
    return () => subscription.remove();
  }, [call]);

  const handleMessage = useCallback<NonNullable<WebViewProps["onMessage"]>>(
    (event) => {
      const message = parsePageMessage(event.nativeEvent.data);
      if (!message) return;
      if (message.t === "status") console.log(`[sealed-call] status: ${message.text}`);
      if (message.t === "media") console.log(`[sealed-call] media: ${message.report}`);
      if (message.t === "error") console.log(`[sealed-call] error: ${message.message}`);
      if (message.t === "ready") {
        console.log(
          `[sealed-call] page ready supported=${message.supported}${message.reason ? ` reason=${message.reason}` : ""}`,
        );
      }
      if (message.t === "error" && !message.nonce) onError?.(message.message);
      internal.ingest(message);
    },
    [internal, onError],
  );

  return (
    <View style={styles.fill}>
      <Web
        ref={webView}
        source={
          resolved.kind === "url"
            ? { uri: resolved.url, ...(headers ? { headers } : {}) }
            : { uri: resolved.uri }
        }
        style={[styles.fill, style]}
        originWhitelist={[origin]}
        // Camera and microphone.
        mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback
        mediaCapturePermissionGrantType="grant"
        // Vonage's SDK needs both; domStorage also carries the page's own preferences.
        javaScriptEnabled
        domStorageEnabled
        // Hardware layers keep video smooth on Android; the default can stutter badly.
        androidLayerType="hardware"
        // A call page should never navigate. Anything that tries is a redirect we did not
        // ask for, and following it would hand the camera to another origin.
        onShouldStartLoadWithRequest={(request: { url: string }) => {
          // A call page should never navigate. For a bundled surface the only legitimate
          // load is the file itself; for a remote one, its own origin.
          if (resolved.kind === "file") return request.url.startsWith("file://");
          return request.url.split("#")[0]!.startsWith(origin);
        }}
        // Needed to read the bundled surface, and harmless for a remote one.
        allowFileAccess={resolved.kind === "file"}
        allowFileAccessFromFileURLs={resolved.kind === "file"}
        allowUniversalAccessFromFileURLs={resolved.kind === "file"}
        setSupportMultipleWindows={false}
        allowsBackForwardNavigationGestures={false}
        injectedJavaScriptBeforeContentLoaded={bootstrap}
        onMessage={handleMessage}
        onLoadStart={() => internal.reset()}
        onLoadEnd={() => internal.note({ loaded: true })}
        onHttpError={(event) =>
          internal.note({
            httpStatus: event.nativeEvent.statusCode,
            error: `The server returned ${event.nativeEvent.statusCode} for the call page.`,
          })
        }
        onError={(event) =>
          internal.note({
            error: event.nativeEvent.description || "The call page could not be loaded.",
          })
        }
        onRenderProcessGone={() => {
          internal.note({ error: "The call page stopped unexpectedly." });
          onError?.("The call page stopped unexpectedly.");
        }}
        onContentProcessDidTerminate={() => {
          internal.note({ error: "The call page stopped unexpectedly." });
          onError?.("The call page stopped unexpectedly.");
        }}
        {...webViewProps}
      />
    </View>
  );
}

/** Replaces any existing fragment, so a re-render cannot stack two of them. */
function withFragment(target: string, fragment: string): string {
  return `${target.split("#")[0]}#${fragment}`;
}

function safeOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return url;
  }
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: "#000" },
});

/** True when this platform can host a sealed call at all. */
export const sealedCallPlatformSupported = Platform.OS === "ios" || Platform.OS === "android";
