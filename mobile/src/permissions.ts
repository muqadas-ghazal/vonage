import { useCameraPermissions, useMicrophonePermissions } from "expo-camera";
import { useCallback, useEffect, useState } from "react";
import { PermissionsAndroid, Platform } from "react-native";

/**
 * The OS-level camera and microphone grants.
 *
 * These are separate from the WebView's own permission prompt. `mediaCapturePermissionGrantType`
 * tells WebKit the *page* may capture; it says nothing about whether the *app* may touch
 * the hardware. Without the OS grant, capture inside the WebView fails — and on Android it
 * fails as NotReadableError, not NotAllowedError, because the WebView grants the page and
 * then the native AudioRecord open is refused. That misreads as a busy microphone.
 *
 * On Android the request goes through `PermissionsAndroid` directly rather than through
 * expo-camera. expo-camera's microphone request can resolve as granted without ever showing
 * a dialog, depending on how RECORD_AUDIO is declared, which leaves the app believing it
 * has a permission the OS never gave it.
 */
export type MediaPermissions = {
  granted: boolean;
  /** The user denied and the OS will not ask again — Settings is the only way back. */
  blocked: boolean;
  loading: boolean;
  request(): Promise<boolean>;
};

const ANDROID_PERMISSIONS = [
  PermissionsAndroid.PERMISSIONS.CAMERA,
  PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
] as const;

async function readAndroid(): Promise<{ granted: boolean }> {
  const results = await Promise.all(
    ANDROID_PERMISSIONS.map((permission) => PermissionsAndroid.check(permission)),
  );
  return { granted: results.every(Boolean) };
}

function useAndroidPermissions(): MediaPermissions {
  const [granted, setGranted] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void readAndroid().then((state) => {
      if (cancelled) return;
      setGranted(state.granted);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const request = useCallback(async () => {
    const results = await PermissionsAndroid.requestMultiple([...ANDROID_PERMISSIONS]);
    const values = Object.values(results);
    const allGranted = values.every((value) => value === "granted");
    setGranted(allGranted);
    setBlocked(values.some((value) => value === "never_ask_again"));
    return allGranted;
  }, []);

  return { granted, blocked, loading, request };
}

function useApplePermissions(): MediaPermissions {
  const [camera, requestCamera] = useCameraPermissions();
  const [microphone, requestMicrophone] = useMicrophonePermissions();

  const request = useCallback(async () => {
    // Sequential, not parallel: two OS dialogs raced against each other and one is lost.
    const nextCamera = await requestCamera();
    const nextMicrophone = await requestMicrophone();
    return Boolean(nextCamera?.granted && nextMicrophone?.granted);
  }, [requestCamera, requestMicrophone]);

  return {
    granted: Boolean(camera?.granted && microphone?.granted),
    blocked: Boolean(
      (camera && !camera.granted && !camera.canAskAgain) ||
        (microphone && !microphone.granted && !microphone.canAskAgain),
    ),
    loading: camera === null || microphone === null,
    request,
  };
}

export function useMediaPermissions(): MediaPermissions {
  // Both hooks must be called unconditionally; only one result is used.
  const android = useAndroidPermissions();
  const apple = useApplePermissions();
  return Platform.OS === "android" ? android : apple;
}
