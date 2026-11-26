/**
 * Loads Expo's config-plugin helpers.
 *
 * Node resolves a require from the *real* path of this file, and in a monorepo that is the
 * package's own directory — where `expo` is not a sibling. Worse, on an EAS build server
 * `npm install` runs only in the app directory and npm does not install the
 * devDependencies of a `file:` dependency, so nothing is installed next to this package at
 * all. Reading the app config then throws before the build starts.
 *
 * So resolution is anchored to the app that is loading the plugin, which necessarily has
 * `expo` installed, with the local layouts as fallbacks.
 */
function configPlugins() {
  const attempts = [
    () => require(require.resolve("expo/config-plugins", { paths: [process.cwd()] })),
    () => require(require.resolve("@expo/config-plugins", { paths: [process.cwd()] })),
    () => require("expo/config-plugins"),
    () => require("@expo/config-plugins"),
  ];
  const reasons = [];
  for (const attempt of attempts) {
    try {
      return attempt();
    } catch (error) {
      reasons.push(error && error.message ? error.message : String(error));
    }
  }
  throw new Error(
    "@booth/sealed-call-native: could not load Expo's config plugins. Tried:\n  " +
      reasons.join("\n  "),
  );
}

const { AndroidConfig, withAndroidManifest, withDangerousMod, withInfoPlist } = configPlugins();
const fs = require("fs");
const path = require("path");

/**
 * Expo config plugin for @booth/sealed-call-native.
 *
 * Everything here is something `expo prebuild` has to write into the generated native
 * projects. The library's own AndroidManifest declares the foreground service and merges
 * itself in, but permissions the *app* must request, and the iOS Info.plist, are the app's
 * to declare.
 */

const DEFAULTS = {
  microphonePermission: "Allow $(PRODUCT_NAME) to use your microphone for calls.",
  cameraPermission: "Allow $(PRODUCT_NAME) to use your camera for calls.",
};

function withSealedCallIos(config, props) {
  return withInfoPlist(config, (iosConfig) => {
    const plist = iosConfig.modResults;

    // Without `audio` here, WebKit mutes getUserMedia the moment the app leaves the
    // foreground and the call goes silent. This single entry is what keeps it alive.
    const modes = new Set(plist.UIBackgroundModes ?? []);
    modes.add("audio");
    plist.UIBackgroundModes = Array.from(modes);

    plist.NSMicrophoneUsageDescription =
      props.microphonePermission ??
      plist.NSMicrophoneUsageDescription ??
      DEFAULTS.microphonePermission;
    plist.NSCameraUsageDescription =
      props.cameraPermission ?? plist.NSCameraUsageDescription ?? DEFAULTS.cameraPermission;

    return iosConfig;
  });
}

const SYNC_GRANT = `        // If all the permissions are already granted, send the response to the WebView synchronously
        if (requestedAndroidPermissions.isEmpty()) {
            request.grant(grantedPermissions.toArray(new String[0]));
            grantedPermissions = null;
            return;
        }`;

const DEFERRED_GRANT = `        // Grant on the next turn of the WebView thread. Chromium fails to start the
        // microphone (NotReadableError: Could not start audio source) when grant()
        // runs inside onPermissionRequest itself.
        if (requestedAndroidPermissions.isEmpty()) {
            final String[] resources = grantedPermissions.toArray(new String[0]);
            grantedPermissions = null;
            mWebView.post(() -> request.grant(resources));
            return;
        }`;

function patchWebViewAudioGrant(projectRoot) {
  const relative = path.join(
    "node_modules",
    "react-native-webview",
    "android",
    "src",
    "main",
    "java",
    "com",
    "reactnativecommunity",
    "webview",
    "RNCWebChromeClient.java",
  );
  const candidates = [
    path.join(projectRoot, relative),
    path.join(projectRoot, "..", relative),
  ];
  const target = candidates.find((file) => fs.existsSync(file));
  if (!target) {
    throw new Error(
      "@booth/sealed-call-native: could not find RNCWebChromeClient.java to defer the microphone grant.",
    );
  }
  const source = fs.readFileSync(target, "utf8");
  if (source.includes("mWebView.post(() -> request.grant(resources))")) return;
  if (!source.includes(SYNC_GRANT)) {
    throw new Error(
      "@booth/sealed-call-native: RNCWebChromeClient.java no longer contains the synchronous grant. Check the react-native-webview version.",
    );
  }
  fs.writeFileSync(target, source.replace(SYNC_GRANT, DEFERRED_GRANT));
}

function withWebViewAudioGrant(config) {
  return withDangerousMod(config, [
    "android",
    (mod) => {
      patchWebViewAudioGrant(mod.modRequest.projectRoot);
      return mod;
    },
  ]);
}

function withSealedCallAndroid(config) {
  const withPermissions = AndroidConfig.Permissions.withPermissions(config, [
    "android.permission.CAMERA",
    "android.permission.RECORD_AUDIO",
    "android.permission.FOREGROUND_SERVICE",
    "android.permission.FOREGROUND_SERVICE_MICROPHONE",
    "android.permission.POST_NOTIFICATIONS",
    "android.permission.WAKE_LOCK",
  ]);

  return withAndroidManifest(withPermissions, (androidConfig) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(
      androidConfig.modResults,
    );
    // Hardware acceleration is on by default in modern templates, but an app that turned
    // it off renders WebView video as a black rectangle, which is a miserable thing to
    // debug. Make it explicit.
    application.$["android:hardwareAccelerated"] = "true";
    return androidConfig;
  });
}

module.exports = function withSealedCall(config, props = {}) {
  return withWebViewAudioGrant(withSealedCallAndroid(withSealedCallIos(config, props)));
};
