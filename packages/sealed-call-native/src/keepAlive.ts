import { NativeModules, Platform } from "react-native";

type NativePermissionState = {
  recordAudio: boolean;
  camera: boolean;
  /** AudioManager mode: 0 NORMAL, 2 IN_CALL, 3 IN_COMMUNICATION. */
  audioMode: number;
  micMuted: boolean;
};

type KeepAliveModule = {
  start(title: string, body: string): Promise<void>;
  stop(): Promise<void>;
  prepareAudio?(): Promise<void>;
  releaseAudio?(): Promise<void>;
  permissionState?(): Promise<NativePermissionState>;
};

export type { NativePermissionState };

const native = (NativeModules as Record<string, KeepAliveModule | undefined>)
  .SealedCallKeepAlive;

export type KeepAliveOptions = {
  /** Shown in the Android notification. Ignored on iOS. */
  title?: string;
  body?: string;
};

/**
 * Keeps the call running while the app is in the background.
 *
 * On Android this starts a microphone-typed foreground service. Android 14+ refuses to
 * start one from the background, which is why this must be called while the user is
 * looking at the call — joining a meeting is exactly that moment.
 *
 * On iOS it activates an `AVAudioSession` configured for voice chat. That, together with
 * the `audio` entry in `UIBackgroundModes`, is what stops WebKit muting the microphone
 * when the app leaves the foreground.
 *
 * Note what this cannot do: **the camera stops in the background on both platforms.** That
 * is an OS privacy rule that applies to every app, native ones included. Audio continues,
 * the session stays connected, and video resumes when the user comes back.
 */
export async function startKeepAlive(options: KeepAliveOptions = {}): Promise<boolean> {
  if (!native) return false;
  try {
    await native.start(
      options.title ?? "Call in progress",
      options.body ?? "Tap to return to the call",
    );
    return true;
  } catch {
    return false;
  }
}

export async function stopKeepAlive(): Promise<void> {
  if (!native) return;
  try {
    await native.stop();
  } catch {
    // Stopping is best-effort: a failure here must never block leaving the call.
  }
}

/** False when the native module is not linked — the call still works, it just drops in the background. */
export function keepAliveAvailable(): boolean {
  return Boolean(native);
}

export const keepAlivePlatformNote =
  Platform.OS === "android"
    ? "Android: needs the microphone foreground service declared in AndroidManifest.xml."
    : "iOS: needs `audio` in UIBackgroundModes.";

/**
 * Claims the microphone for a voice call before the WebView tries to capture.
 *
 * Android arbitrates capture by audio focus and declared use case, so an app that just
 * calls getUserMedia can be refused with NotReadableError while another process holds the
 * device. Requesting AUDIOFOCUS_GAIN with USAGE_VOICE_COMMUNICATION and setting
 * MODE_IN_COMMUNICATION is how a native calling app takes it instead of asking.
 *
 * iOS needs nothing here — `startKeepAlive` already configures AVAudioSession.
 */
export async function prepareAudio(): Promise<boolean> {
  if (Platform.OS !== "android" || !native?.prepareAudio) return false;
  try {
    await native.prepareAudio();
    return true;
  } catch {
    return false;
  }
}

export async function releaseAudio(): Promise<void> {
  if (Platform.OS !== "android" || !native?.releaseAudio) return;
  try {
    await native.releaseAudio();
  } catch {
    // Best effort: failing to restore the audio mode must not block leaving a call.
  }
}

/**
 * The OS's own view of the capture permissions, rather than a JS library's.
 *
 * Needed because `enumerateDevices` populates device labels once *any* capture permission
 * is granted — so a page can look permitted for audio when only the camera was allowed.
 */
export async function nativePermissionState(): Promise<NativePermissionState | null> {
  if (!native?.permissionState) return null;
  try {
    return await native.permissionState();
  } catch {
    return null;
  }
}
