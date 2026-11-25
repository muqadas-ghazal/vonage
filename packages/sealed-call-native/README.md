# @booth/sealed-call-native

End-to-end encrypted Vonage video calls in React Native.

Vonage runs the call exactly as it does on the web — signalling, negotiation, codecs,
reconnection. This package contributes the two things a mobile shell has to provide: the
permissions and background audio that keep a call alive, and a message channel so the
encryption UI is native while the crypto runs where it can.

## Why a WebView

Frame-level encryption needs `RTCRtpScriptTransform` — the one seam in the WebRTC pipeline
that sits after the encoder and before the packetizer. No React Native WebRTC library
exposes it, and Vonage's native SDKs have no equivalent: their entire encryption surface
is one call, `otc_session_set_encryption_secret`, which is their paid add-on.

A WebView has a real browser engine, so it has the seam. Your existing `@booth/frame-cipher`
runs unchanged, and the same code secures web and mobile.

| | Minimum |
|---|---|
| Android System WebView | **141** |
| iOS | **15.4** |

Below those, `RTCRtpScriptTransform` does not exist. The bridge reports `status:
"unsupported"` with a reason you can show the user, rather than quietly sending in the clear.

## What backgrounding can and cannot do

**The camera stops when the app leaves the foreground.** Both operating systems revoke
camera access in the background, for every app, native ones included. There is no
entitlement that lifts it.

With this package set up:

| In background | |
|---|---|
| Session stays connected | ✅ no call drop |
| Your microphone keeps sending | ✅ |
| Incoming audio keeps playing | ✅ |
| Incoming video keeps arriving | ✅ |
| **Your camera** | ❌ pauses, resumes on return |

That is the same behaviour as every other calling app. Your crypto is unaffected: a paused
camera is an ordinary track mute, so audio keeps being sealed and no key changes.

## Install

```sh
npm install @booth/sealed-call-native react-native-webview
cd ios && pod install
```

### iOS

`Info.plist`:

```xml
<key>UIBackgroundModes</key>
<array>
  <string>audio</string>
</array>
<key>NSMicrophoneUsageDescription</key>
<string>Booth uses your microphone for calls.</string>
<key>NSCameraUsageDescription</key>
<string>Booth uses your camera for calls.</string>
```

The `audio` entry is not optional and not cosmetic: **WebKit checks the host app's
`UIBackgroundModes` and mutes `getUserMedia` when `audio` is absent.** Without it the call
goes silent the moment the user switches apps.

### Android

The library manifest already declares the service and its permissions, so a manifest merge
brings them in. Nothing to add unless you have `tools:node="remove"` rules.

If you declare permissions explicitly:

```xml
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MICROPHONE" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.CAMERA" />
```

Register the package in `MainApplication.kt`:

```kotlin
import com.booth.sealedcall.SealedCallPackage

override fun getPackages(): List<ReactPackage> =
  PackageList(this).packages.apply {
    add(SealedCallPackage())
  }
```

## Request OS permissions before mounting

This is the one step that will waste your afternoon if you skip it.

`mediaCapturePermissionGrantType="grant"` tells WebKit that the *page* may capture. It
says nothing about whether the *app* is allowed to touch the hardware. Without the OS
grant, `getUserMedia` inside the WebView fails, the call stalls after connecting, and
**there is no prompt and nothing in the log**.

So ask first, and do not mount `<SealedCall>` until you have them:

```tsx
import { useCameraPermissions, useMicrophonePermissions } from "expo-camera";

const [camera, requestCamera] = useCameraPermissions();
const [microphone, requestMicrophone] = useMicrophonePermissions();

if (!camera?.granted || !microphone?.granted) return <GrantScreen … />;
return <SealedCall … />;
```

Request them **sequentially**. Two OS dialogs raced against each other and one gets lost.

See `mobile/src/permissions.ts` for a working hook.

## Usage

```tsx
import { SealedCall, useSealedCall } from "@booth/sealed-call-native";

export function CallScreen({ room }: { room: string }) {
  const call = useSealedCall({
    onUnsupported: (reason) => Alert.alert("Cannot encrypt", reason),
  });

  return (
    <View style={{ flex: 1 }}>
      <SealedCall
        url={`https://your-app.vercel.app/call/${room}`}
        call={call}
        keepAlive={{ title: "Booth call", body: "Tap to return" }}
      />

      {call.state.status === "locked" && (
        <UnlockPrompt
          onSubmit={(passphrase) => call.setKey(passphrase)}
          onFingerprint={(passphrase) => call.fingerprint(passphrase)}
        />
      )}
    </View>
  );
}
```

### The URL must be https

`getUserMedia` needs a secure context. A `source={{ html }}` string loads as `about:blank`
and a bundled page loads as `file://` — neither can get the camera. Point `url` at your
deployed site.

### Keep it mounted

Unmounting `<SealedCall>` tears down the peer connection. Remounting is a rejoin, not a
resume. Keep it mounted for the life of the meeting and let the keep-alive handle
backgrounding.

## API

### `useSealedCall(options?)`

| Member | |
|---|---|
| `state.status` | `connecting` \| `unsupported` \| `clear` \| `locked` \| `sealed` |
| `state.hasKey` / `sending` | whether we hold a key and are sealing |
| `state.keyId` | short public tag; equal on both sides means the same key |
| `state.lockedStreams` | peers sealed with a key we do not hold |
| `state.securedStreams` | peers we are decrypting |
| `state.plaintextStreams` | peers still in the clear |
| `setKey(value, mode?)` | `"passphrase"` (default, PBKDF2-stretched) or `"raw"` |
| `forgetKey()` | stop sealing and drop the key |
| `fingerprint(value, mode?)` | the digest to read aloud, to confirm both sides match |
| `trackState(trackId)` | `sealed` \| `locked` \| `clear` \| `unknown` for one tile |
| `sync()` | ask the page to resend state; called automatically on foreground |

Keys travel into the WebView only. They are never stored, logged, or sent back out.

### `<SealedCall>`

| Prop | |
|---|---|
| `url` | the call page, over https |
| `call` | the controller from `useSealedCall()` |
| `keepAlive` | `{ title, body }` for the Android notification, or `false` to opt out |
| `webViewProps` | merged into the underlying `WebView` |
| `onError` | page crashes and unsolicited page errors |

### Keep-alive, used directly

```ts
import { startKeepAlive, stopKeepAlive, keepAliveAvailable } from "@booth/sealed-call-native";
```

`<SealedCall>` calls these on mount and unmount. Call them yourself only if you manage the
WebView's lifecycle differently.

## Web side

The call page installs the other half of the bridge:

```ts
import { installPageBridge, isHosted } from "@booth/sealed-call-native/web";
```

`isHosted()` is false in a normal browser and the installer is a no-op, so the same page
serves web and mobile. See `src/lib/native-bridge.ts` in the Booth app for a wired example.

## Troubleshooting

**Call drops a few seconds after backgrounding on Android.** The foreground service did not
start. Check `SealedCallPackage` is registered and that you mounted `<SealedCall>` while the
screen was visible — Android 14+ refuses to start a microphone-typed service from the
background.

**Audio goes silent when the app backgrounds on iOS.** `audio` is missing from
`UIBackgroundModes`. This is the single most common cause.

**`status` is `unsupported` on Android.** System WebView is older than 141. It updates
through the Play Store; a device without Play services may be stuck.

**Camera never appears.** The app is missing the runtime OS permission, or the URL is not
https.

**Keys sent before the page loads appear to vanish.** They do not — early messages are
queued on the page and drained when its bridge installs. If a key is genuinely ignored,
check the page is actually loading `installNativeBridge()`.

**Tiles stay locked after both sides enter the same passphrase.** Compare `state.keyId` on
both devices. Different values mean different keys — most often a different room name, since
the passphrase is salted with it.
