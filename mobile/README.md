# Booth sealed call — Expo test app

A device harness for `@booth/sealed-call-native`. Vonage runs the call inside the web page;
this app drives the encryption from native UI and keeps the call alive in the background.

## Run it

The app consumes the workspace package from source, so build that first:

```sh
cd ..            # repo root
npm run build:sdk
```

Then, from this folder:

```sh
BOOTH_CALL_URL=https://your-app.vercel.app npx expo run:android
# or
BOOTH_CALL_URL=https://your-app.vercel.app npx expo run:ios
```

You can also leave the environment variable out and type the URL on the first screen.

### Expo Go will not work

The background keep-alive is a native module, so it needs a **dev build** —
`expo run:android` / `expo run:ios`, or an EAS build. In Expo Go the call still runs and
still encrypts, but it drops when the app backgrounds, and the first screen says so.

### The URL must be https

`getUserMedia` needs a secure context. A plain-http dev server cannot get the camera, so
point this at your deployed site (or an https tunnel).

## Development build (needed for the background test)

Expo Go cannot run the background keep-alive: that is a native module, and Expo Go only
contains the native modules it was built with. Everything else — the call, the
encryption, the lobby, the lock and unlock flow — works in Expo Go.

With no local Android SDK or Xcode, build in the cloud:

```sh
npx eas-cli login
npx eas-cli init          # adds a projectId to app.json, once
npx eas-cli build --profile development --platform android
```

Install the APK it gives you, then point Metro at it:

```sh
npx expo start --dev-client
```

Day to day this feels exactly like Expo Go — same fast refresh, JS still served from
Metro. **Rebuild only when native things change**: a new native dependency, an edit to the
config plugin, or an Expo SDK bump. JavaScript edits never need a rebuild.

Start with Android. iOS development builds need a provisioning profile and a paid Apple
Developer account; Android needs neither.

### Profiles

| Profile | What it is |
|---|---|
| `development` | dev client, APK, installable directly — use this for the background test |
| `preview` | release JS, APK, for sharing a build with someone |
| `production` | App Bundle for Play, version managed by EAS |

`development` deliberately has no `BOOTH_CALL_URL`, so you type the backend on the first
screen and can switch between localhost, an ngrok tunnel and production without rebuilding.

For `preview` and `production` a shipped app should not ask the user for a backend URL, so
set it once in EAS and it is baked in at build time:

```sh
npx eas-cli env:create --name BOOTH_CALL_URL --value https://your-app.vercel.app \
  --environment preview --environment production
```

Do not put it in `eas.json` as `env: { "BOOTH_CALL_URL": "" }` — EAS rejects an empty
value, and a real URL in a committed file is the wrong place for it anyway.

## Permissions

The first time you enter a call the app asks for camera and microphone. Grant both — the
WebView cannot reach the hardware unless the app itself holds the OS permission, and
without it the call connects and then stalls at "Asking for the camera and microphone…"
with no prompt of its own.

If you denied them earlier, the app says so and the only way back is Settings.

## Reading the diagnostics line

The bottom panel shows what the WebView and the page are doing:

```
page loaded · Connecting…
sealed 0 · locked 0 · clear 0
```

The stages run: `Reading settings… → Joining <room>… → Loading the video SDK… →
Connecting… → Asking for the camera and microphone… → In the call`. Where it stops tells
you which part failed, and any error appears in red with the real Vonage code.

## Testing it properly

Two devices, or one device and a browser tab, in the same room.

1. **Join on both.** Both should read `In the clear` — unencrypted is the default.
2. **Seal on one.** Type a passphrase, tap Seal. That side goes `Sealed`. The other side
   goes `Locked` and its video goes dark — not scrambled, dark. That distinction is the
   whole point: a wrong or missing key drops frames instead of feeding the decoder noise.
3. **Compare fingerprints.** The digest shown after sealing must match on both. It is
   derived from the passphrase and the room name, so a mismatch usually means a different
   room.
4. **Seal on the other.** Enter the same passphrase. Both go `Sealed`, video returns both
   ways, and the panel shows `key` equal on both devices.
5. **Background test.** Put the app in the background, or lock the screen, and keep talking.
   Audio should continue and the call should not drop. Come back and video resumes.

Watch the panel at the bottom: `sealed / locked / clear` counts, the key id, the generation,
and each inbound track's own state.

## What backgrounding does and does not do

**The camera stops when the app leaves the foreground.** Both operating systems revoke
camera access in the background for every app, native ones included. Audio continues, the
session stays connected, incoming video keeps arriving, and your camera resumes on return.
That is the same behaviour as every other calling app, and it costs the crypto nothing — a
paused camera is an ordinary track mute.

## Notes

- `android/` and `ios/` are generated by `expo prebuild` and are gitignored. The Expo config
  plugin in the package writes everything they need: `UIBackgroundModes: ["audio"]`, the two
  usage descriptions, the Android permissions, and `hardwareAccelerated`.
- The native module autolinks — no `MainApplication.kt` edit.
- `metro.config.js` is monorepo-aware: it watches the repo root and pins `nodeModulesPaths`,
  so the app does not pick up the web app's copy of React.
