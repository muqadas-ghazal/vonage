# @booth/frame-cipher

End-to-end encryption for WebRTC media, applied to each **encoded frame**.

Your video SDK's servers — Vonage, LiveKit, Twilio, or your own SFU — keep routing the
call, but they only ever carry ciphertext. Keys are derived in the browser and never sent
anywhere.

```
camera ─▶ encoder ─▶ [ seal ] ─▶ packetizer ─▶ ~~~ Vonage ~~~ ─▶ [ open ] ─▶ decoder ─▶ screen
                        ▲                                           ▲
                        └──────── your key, never leaves the browser ┘
```

---

## ⛔ Read this first: platform support

| Platform | Frame encryption | Key helpers (`/keys`) |
| --- | --- | --- |
| Chrome / Edge **141+** | ✅ | ✅ |
| Firefox **117+** | ✅ | ✅ |
| Safari **15.4+** | ✅ | ✅ |
| Chrome / Edge below 141 | ❌ | ✅ |
| **React Native** | ❌ **never** | ✅ |
| Node (tests, tooling) | ❌ | ✅ |

### If you are building on React Native, you do not want this package for encryption

**Vonage already ships end-to-end encryption on React Native, and you should use it.**

```tsx
import { OTSession } from "opentok-react-native";

<OTSession apiKey={apiKey} sessionId={sessionId} token={token} encryptionSecret={secret} />
```

That hands your secret to Vonage's native iOS/Android SDKs, which do the frame encryption
in native code. It is the supported path and it works today.

**This package cannot be made to work there.** Not a gap to be filled later — three
independent reasons:

1. React Native has no `RTCRtpScriptTransform`. The whole package is built on it.
2. `react-native-webrtc` has no frame cryptor. The pull request that added one
   ([#1843](https://github.com/react-native-webrtc/react-native-webrtc/pull/1843)) was
   **closed without being merged** in October 2026, and release 155.0.0 does not contain it.
3. Most decisively, `opentok-react-native` has **no JavaScript `RTCPeerConnection` at
   all**. It is a thin bridge to the native SDKs, so there is no peer connection object in
   JS for this package to attach a transform to. Even a perfect `react-native-webrtc`
   would not help, because the Vonage React Native SDK does not use it.

### What this package still gives a React Native app

The `@booth/frame-cipher/keys` entry point has no DOM, no WebRTC, no `btoa`, and no
`Buffer` — there is a test that deletes all of those before importing it. Use it to
generate and share the secret you pass to Vonage:

```ts
import "react-native-get-random-values"; // once, at the top of your entry file
import { generateMediaKey, encodeMediaKey, mediaKeyFingerprintSync } from "@booth/frame-cipher/keys";

const key = generateMediaKey();                 // 32 bytes from the platform CSPRNG
const secret = encodeMediaKey(key);             // URL-safe string for <OTSession encryptionSecret=…>
console.log(mediaKeyFingerprintSync(key));      // "941a" — compare across participants
```

`generateMediaKey` needs a CSPRNG, which React Native does not have built in. Install
[`react-native-get-random-values`](https://www.npmjs.com/package/react-native-get-random-values)
and import it once before anything else, or you get a thrown error naming exactly this.

### Can a React Native participant and a browser participant share a call?

Only if both sides use the **same** scheme. Vonage's E2EE and this package are different
formats and cannot decrypt each other. So:

| Your platforms | Use |
| --- | --- |
| React Native, or RN + web | **Vonage's `encryptionSecret`** on every client, including web. Requires the E2EE add-on on your Vonage account, and disables archiving, live streaming, Experience Composer, Audio Connector and SIP. |
| Browser only | **This package.** No add-on, no provider lock-in, works on Firefox, and you control the ratchet, replay window and authentication. |

Calling `createFrameCipher()` on React Native throws an error naming the Vonage
alternative. It never silently sends plaintext.

---

## What it does (browser)

- **Zero config.** The worker is inlined; nothing to copy into `public/`, no bundler setup.
- **Not tied to Vonage.** It patches `RTCPeerConnection`, so it works with any SDK built on it.
- **AES-GCM, per sender, per generation.** Keys are derived with HKDF; nonces are counters,
  so nonce reuse is structurally impossible rather than statistically unlikely.
- **Everything in the clear is authenticated.** The readable codec header and every parsing
  field are covered by the GCM tag, so they cannot be rewritten in transit.
- **Replay protection** via a 1024-frame sliding window, per inbound stream.
- **Ratcheting** for forward secrecy when you rekey on membership change.
- **Observable.** Per-stream counters and per-frame samples, for the console or your own UI.

---

## Requirements

Browser frame encryption needs the
[WebRTC Encoded Transform](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpScriptTransform)
API (`RTCRtpScriptTransform`): **Chrome/Edge 141+, Firefox 117+, Safari 15.4+**. Chrome's
number is the one to watch — it carried the non-standard `createEncodedStreams()` for years
and only shipped the standard API in 141 (October 2025). This package does not implement
the legacy path, so Chrome 140 and below fall into the unsupported branch rather than
encrypting. If you need pinned enterprise Chrome, that fallback is the one thing worth adding.

Always gate on the capability check rather than assuming:

```ts
import { frameCipherSupport } from "@booth/frame-cipher";

const support = frameCipherSupport();
if (!support.supported) console.warn(support.reason);
```

## Install

```bash
npm install @booth/frame-cipher
```

In a monorepo, add it as a workspace and depend on it with `"@booth/frame-cipher": "*"`.

---

## Quick start

```ts
import { createFrameCipher, ensureMediaKey } from "@booth/frame-cipher";

// 1. Get the call secret. Reads it from the URL fragment (#k=...) if present,
//    otherwise reuses this tab's, otherwise mints one and puts it in the address bar.
const key = ensureMediaKey();

// 2. Create the cipher and patch RTCPeerConnection.
const cipher = createFrameCipher({ key });
cipher.install();

// 3. NOW load your video SDK.
const OT = await import("@vonage/client-sdk-video");
```

> ### ⚠️ `install()` must run before the SDK is imported
>
> Video SDKs capture `RTCPeerConnection.prototype` methods as their module loads. Patch
> after that and your frames go out in the clear with no error. Use a dynamic `import()`
> for the SDK, as above, so you control the ordering.

On teardown:

```ts
cipher.destroy(); // wipes key material, terminates the worker, restores RTCPeerConnection
```

---

## How the keys work

The 32 bytes you pass in are **root material, never an AES key**. Everything is derived
from them with HKDF-SHA256:

```
root                = your 32-byte call secret
generation[0]       = HKDF(root,          "fc/v2/gen0")
generation[n+1]     = HKDF(generation[n], "fc/v2/ratchet")           ← one-way
(key, nonceBase)    = HKDF(generation[g], "fc/v2/sender/" + kind, salt = senderId)
keyId               = HKDF(generation[g], "fc/v2/keyid", 2 bytes)
```

Two consequences worth understanding:

**Each sender has its own key per media kind, inside each generation.** A nonce is
`nonceBase XOR counter` with a 48-bit monotonic counter, so a nonce can only repeat if one
sender reuses a counter under one key — which cannot happen. Audio and video are keyed
separately so they do not have to share a counter space, which in turn lets each inbound
stream keep its own replay window. This matters: AES-GCM does not merely leak
plaintext on nonce reuse, it leaks the authentication key, letting an attacker forge
frames. Random nonces under a key shared by every participant are the construction that
makes this a live risk; counters under per-sender keys remove it.

**Generations only move forward.** `generation[n]` cannot produce `generation[n-1]`, so
forgetting an old generation makes its frames permanently unreadable.

---

## Rekeying (forward secrecy)

Call `ratchet()` when the set of participants changes. Every participant must ratchet, so
drive it from an event they all observe.

```ts
session.on("connectionCreated", () => cipher.ratchet());
session.on("connectionDestroyed", () => cipher.ratchet());
```

Frames carry their generation, so a receiver follows a sender forward automatically. The
previous `generationGrace` generations (default 2) stay readable so frames already in
flight during a rekey still decode; anything older is dropped and its key destroyed.

> ### How much forward secrecy you actually get
>
> With `forwardSecrecy: true` (the default) the root secret is discarded once generation 0
> is derived, so **the worker's state cannot rebuild an earlier key**. That protects you
> against later compromise of the running page.
>
> It does **not** protect you against someone who holds the call secret itself — and if you
> distribute keys by link, the secret is sitting in the URL, in browser history, and in
> whatever chat you pasted it into. Anyone with that link re-derives every generation from
> scratch.
>
> To get forward secrecy that means something against a leaked link, the root has to be
> ephemeral: do an authenticated ECDH exchange over your signalling channel and feed the
> resulting shared secret in as `key`. The ratchet is built to sit underneath exactly that.
>
> A cheaper partial measure: call `ensureMediaKey({ storage: null })` and strip the
> fragment from the URL after joining, so the secret lives only in memory.

---

## Sharing the call secret

Everyone needs the **same 32 bytes**. The library does not distribute them for you — that
is deliberate, since a server that hands out keys can decrypt everything and the
end-to-end property is gone.

### Pattern 1 — secret in the link fragment (simplest)

Text after `#` is stripped by the browser before any HTTP request, so your server and your
video provider never see it.

```ts
import { ensureMediaKey, withKeyFragment } from "@booth/frame-cipher";

const key = ensureMediaKey();
const invite = withKeyFragment(`${location.origin}/call/${room}`, key);
// → https://example.com/call/quiet-window#k=7Qk1...
```

**Share that whole string.** A link without the `#k=` part is the most common cause of a
dead remote tile: the person who opens it mints their own secret and can decrypt nobody.

Tradeoffs: anyone with the link can decrypt, links persist in chat history, and as noted
above the ratchet gives you little against a leaked link.

### Pattern 2 — key agreement over your signalling channel

Better for production. Participants exchange ECDH public keys over a channel you already
have (Vonage's `session.signal()`, a data channel, your own WebSocket), derive a shared
secret locally, and pass it in as `key`. The relay sees only public keys.

Authenticate the exchange — a bare ECDH over a server you do not control is MITM-able by
that server. Using the link secret as an HMAC key over the transcript works well: the link
stops being a decryption key and becomes an authentication root.

### Checking both ends agree

```ts
console.log(cipher.keyId()); // "941a" — same tag on both ends means the same key
```

Also printed in every log line. A mismatch fires `onKeyMismatch` rather than rendering
garbage.

---

## Framework recipes

### Next.js (App Router)

Everything runs in the browser, so keep it in a client component.

```tsx
"use client";

import { useEffect, useRef } from "react";
import { createFrameCipher, ensureMediaKey, type FrameCipher } from "@booth/frame-cipher";

export function Call({ room }: { room: string }) {
  const cipher = useRef<FrameCipher | null>(null);

  useEffect(() => {
    let active = true;

    (async () => {
      cipher.current = createFrameCipher({
        key: ensureMediaKey(),
        onKeyMismatch: (info) => console.warn("different key in the room", info),
      });
      cipher.current.install();

      const OT = await import("@vonage/client-sdk-video"); // after install()
      if (!active) return;
      // ... initPublisher / initSession as usual
    })();

    return () => {
      active = false;
      cipher.current?.destroy();
      cipher.current = null;
    };
  }, [room]);

  return <div id="stage" />;
}
```

No `next.config` changes, no file in `public/`. If you render anything from the cipher
during SSR, note that `useCipherLog` returns an empty snapshot on the server.

### React / Vite / CRA

Identical to the above minus the `"use client"` directive.

### Plain JavaScript

```html
<script type="module">
  import { createFrameCipher, ensureMediaKey } from "/node_modules/@booth/frame-cipher/dist/index.js";
  createFrameCipher({ key: ensureMediaKey() }).install();
</script>
```

### React Native

See [platform support](#-read-this-first-platform-support) at the top. Use Vonage's
`encryptionSecret`; this package's `/keys` entry point still helps you generate and share it.

---

## Observing the flow

Every stream reports counters once a second, plus a full breakdown of its first few frames.

```ts
const cipher = createFrameCipher({
  key,
  sampleFrames: 3,   // frames logged in detail per stream; default 3
  verbose: false,    // true logs every frame (one postMessage each)
  console: true,     // mirror to console; defaults to false in production
  onLog: (entry) => myLogger.debug(entry.text, entry.detail),
});
```

A sampled frame looks like:

```
cipher  #16 video frame 3 (delta) plain → sealed
  headerKeptClear: "3B 111500"
  bodyBefore: "e3738fdc8ba7a747"
  bodyAfter:  "417fb3b44e3fa812"
  bytes: "1262 → 1297"
  generation: 0
  counter: 2
```

### React

```tsx
import { useCipherLog } from "@booth/frame-cipher/react";
import { directionOf, formatBytes } from "@booth/frame-cipher";

function CipherPanel({ cipher }) {
  const { streams } = useCipherLog(cipher);
  const live = streams.filter((s) => s.open && s.frames > 0);

  return (
    <ul>
      {live.map((s) => (
        <li key={s.id}>
          {directionOf(s.op)} {s.kind} — {s.frames} frames, {formatBytes(s.outBytes)}
          {s.failed > 0 && ` · ${s.failed} failed auth`}
          {s.replayed > 0 && ` · ${s.replayed} replayed`}
        </li>
      ))}
    </ul>
  );
}
```

`directionOf` returns `"out"` for frames sealed here before they leave, `"in"` for frames
opened here before the decoder sees them.

---

## API

### `createFrameCipher(options): FrameCipher`

| Option | Default | Meaning |
| --- | --- | --- |
| `key` | — | **Required.** 32 bytes of HKDF root material, shared by all participants. |
| `senderId` | random 4 B | Identifies this participant. Two participants sharing one would share a key and counter space — pass a stable value from your signalling identity when you have one. |
| `headerPolicy` | `"sfu"` | `"sfu"` keeps the codec header readable; `"full"` encrypts the whole frame. See the caveat below before choosing `"full"`. |
| `forwardSecrecy` | `true` | Discard the root after deriving generation 0 and forget generations past the grace window. |
| `generationGrace` | `2` | Generations kept readable behind the current one, for frames in flight during a rekey. |
| `workerUrl` | inline blob | Serve the worker yourself; see [CSP](#content-security-policy). |
| `sampleFrames` | `3` | Frames logged in full per stream before switching to counters. |
| `verbose` | `false` | Log every frame. |
| `console` | dev only | Mirror the log to the browser console. |
| `patchSetParameters` | `true` | Shim for Vonage; see [Vonage notes](#vonage-notes). |
| `onLog` | — | Called with each log entry. |
| `onKeyMismatch` | — | Called once when a frame arrives sealed under a different secret. |

Returns:

| Method | Purpose |
| --- | --- |
| `install()` | Patch `RTCPeerConnection` so every sender/receiver is transformed. Call before loading your SDK. |
| `uninstall()` | Restore the original methods. Running transforms continue. |
| `ratchet()` | Advance the key generation. Call on membership change, on every participant. |
| `generation()` | The generation this endpoint is sending under. |
| `senderId()` | This participant's 4-byte id, as hex. |
| `keyId()` | Short key tag once a stream has opened, else `null`. |
| `armPeerConnection(pc)` | Attach by hand, if your SDK exposes the peer connection. |
| `protectSender(sender, kind?)` / `protectReceiver(receiver, kind?)` | Attach to one endpoint. |
| `setVerbose(bool)` / `isVerbose()` | Toggle per-frame logging at runtime. |
| `getStreams()` | Current `CipherStream[]`. |
| `snapshot()` / `subscribe(fn)` | `useSyncExternalStore`-shaped pair. |
| `destroy()` | Wipe key material, terminate the worker, uninstall. |

### Keys

Importable from `@booth/frame-cipher` **or** from `@booth/frame-cipher/keys`, which pulls
in no DOM or WebRTC code and is safe on React Native and in Node.

| Function | Purpose |
| --- | --- |
| `generateMediaKey()` | 32 random bytes. |
| `ensureMediaKey(options?)` | Link fragment → tab storage → fresh secret, and updates the address bar. Pass `{ storage: null }` to keep it in memory only. |
| `encodeMediaKey` / `decodeMediaKey` | base64url ⇄ bytes. |
| `mediaKeyFingerprint(key)` | Short public tag, e.g. `"941a"`. |
| `mediaKeyFingerprintSync(key)` | Same, without awaiting. |
| `readKeyFromFragment(url?)` | Parse `#k=...`; `null` if absent or malformed. |
| `withKeyFragment(url, key)` | Attach a secret to a URL. |

### Capability

`frameCipherSupport()` → `{ supported, reason? }`, and `isFrameCipherSupported()`.

---

## Wire format

```
[ clear header ][ ciphertext ‖ 16B GCM tag ][ senderId ‖ counter ‖ gen ‖ flags ‖ headerLen ‖ keyId ‖ magic ]
  0/1/3/10 B                                     4 B        6 B     1 B    1 B       1 B       2 B    4 B
```

- The **clear header** is left readable so an SFU can still classify and route the frame:
  10 bytes for a video key frame, 3 for a delta frame, 1 for audio (the VP8/VP9
  convention), or 0 under `headerPolicy: "full"`.

  > **`headerPolicy: "full"` is not free.** It hides the frame type and the video
  > dimensions, which is a genuine confidentiality gain. But the receiving WebRTC stack
  > reads that same header to tell key frames from delta frames, and once it is encrypted
  > that classification is wrong — measurably so: in a live call the receiver reported 27
  > of 48 frames as key frames where the sender had sent 2. Frames still decrypt and play
  > correctly, because the real header length travels in the authenticated trailer. What
  > degrades is the stack's recovery after packet loss, since it can no longer identify a
  > decodable restart point. Prefer `"sfu"` unless hiding frame type genuinely matters more
  > to you than loss resilience.
- **Everything outside the ciphertext is passed to AES-GCM as `additionalData`**, so the
  clear header and all nine trailer bytes of metadata are covered by the authentication
  tag. Rewriting a header byte, the counter, the generation, or the declared header length
  invalidates the frame. There are tests for each of those.
- The **nonce is derived, not transmitted** — `nonceBase XOR counter`.
- **`keyId`** rotates per generation. A receiver compares it and drops mismatched frames
  rather than handing noise to the decoder.
- **`magic`** marks our frames; anything else passes through untouched.

Overhead is a constant **35 bytes per frame** — about 1 KB/s for 30fps video.

---

## Security notes

**What this protects.** Media is unreadable to your signalling server, your video provider,
and anything between. Modified frames are rejected, not decoded. Captured frames cannot be
replayed. Nonce reuse is structurally impossible.

**What it does not protect.**

- **Metadata.** Who is in the call, when, for how long, and roughly who is speaking —
  packet sizes and timing are visible. Frame sizes leak coarse motion information.
- **A malicious participant.** Anyone holding the call secret is a full participant and can
  impersonate any other sender, since `senderId` is self-asserted. Only per-sender
  signatures fix that, at roughly 64 bytes per frame.
- **A leaked root secret.** See the forward-secrecy box above: the ratchet protects against
  later compromise of the running page, not against someone who has your link.
- **The clear codec header** under `headerPolicy: "sfu"`. It is authenticated but not
  secret, so frame type and rough structure are visible. Use `"full"` where you can.
- **Your own server.** This is the ceiling on all browser E2EE: whoever serves your
  JavaScript can serve key-stealing JavaScript. Subresource Integrity and code transparency
  reduce this; nothing eliminates it.

**Key handling.** Derived keys are imported non-extractable. The root is wiped from worker
memory once generation 0 exists, and `destroy()` zeroes every remaining secret. By default
`ensureMediaKey` keeps the secret in `sessionStorage` (per tab, cleared on close); pass
`{ storage: null }` to avoid that. Nothing is ever sent to a server.

---

## Content-Security-Policy

By default the worker is created from a `blob:` URL, which needs:

```
worker-src 'self' blob:
```

If your CSP forbids that, serve the worker file yourself. It ships at
`@booth/frame-cipher/worker` — copy it into your static directory and point at it:

```ts
createFrameCipher({ key, workerUrl: "/frame-cipher.worker.js" });
```

---

## Vonage notes

Works with `@vonage/client-sdk-video`. Three specifics:

1. **Load order.** `install()` before `import("@vonage/client-sdk-video")`. The SDK
   snapshots peer-connection methods at module load.
2. **`setParameters`.** The SDK passes fields Chrome rejects, which aborts its bitrate
   control. `patchSetParameters` (on by default) merges the requested encodings into the
   live parameters instead. Set it to `false` if it conflicts with another shim.
3. **Rekeying.** `connectionCreated` fires for your own connection too, so filter on
   `session.connection.connectionId` before counting participants — and note that calling
   `ratchet()` on every such event is correct, since all participants see them.

Relayed (P2P) and routed (SFU) sessions both work. Keep the default `headerPolicy: "sfu"`
in routed mode so the media server can still read the codec header.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Remote tile black, `mismatched` climbing | Different call secrets — the link was shared without its `#k=` part. Compare `cipher.keyId()` on both ends. |
| `failed` climbing | Frames failing authentication: tampering, or a format mismatch between versions. |
| `replayed` climbing | Duplicate frames being re-delivered or injected. |
| `staleGeneration` climbing | A participant ratcheted and others did not. Make sure every peer calls `ratchet()` on the same event. |
| Media works but nothing is encrypted | `install()` ran after the SDK was imported. |
| Video breaks or recovers slowly after loss | `headerPolicy: "full"` — see the caveat under [Wire format](#wire-format). |
| `createFrameCipher` throws | Unsupported runtime; read `frameCipherSupport().reason`. |
| Worker fails to start | CSP blocks `blob:` workers — see [CSP](#content-security-policy). |
| `no secure random source` on React Native | Import `react-native-get-random-values` once, before anything else. |
| RN and web participants cannot hear each other | They are using different encryption schemes. See [platform support](#-read-this-first-platform-support). |

A scrambled-but-recognisable picture is **not** a symptom of this version: unverified bytes
are never handed to the decoder. If you see one, the cipher is not actually attached.

---

## Development

```bash
npm run build   # tsc + emit the standalone worker file
npm test        # 48 tests: 39 against the shipped worker source, 9 proving /keys is DOM-free
```

The crypto exists once, as the string in `src/worker-source.ts`. The tests evaluate that
same string, so tested code and shipped code cannot drift apart.

## License

MIT
