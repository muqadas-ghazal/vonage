# Frame cipher: the whole E2E flow, from zero

This file is the slow version. It walks one video call from “two people open a room” to “a single video frame is locked, sent, and unlocked,” and names the function, the browser API, and the algorithm at each step.

The short API reference stays in [`README.md`](./README.md). Read this file first if you have never used WebRTC or encryption.

---

## 1. The one-sentence version

The browser encrypts each audio and video **frame** (one tiny chunk of sound or picture) **before** it leaves the computer, and the other browser decrypts it **after** it arrives. Vonage still carries the call, but it only ever sees scrambled bytes. The password never goes to our server or to Vonage.

---

## 2. Words used below

| Word | Plain meaning |
| --- | --- |
| **Frame** | One piece of encoded media. Video is about 30 of these per second. Audio is a short slice of sound. This is **not** an HTML iframe. |
| **Encode** | The browser turns the camera picture into a compressed file-like blob (VP8, and so on). Encryption happens **after** this, on those bytes. |
| **Decode** | The reverse: compressed bytes become a picture again. Decryption happens **before** this. |
| **E2E / end-to-end** | Only the people in the call can read the media. The server in the middle cannot. |
| **Key / secret** | 32 random bytes (256 bits). Think of it as the shared password, stored as raw numbers, not as the word you typed. |
| **Ciphertext** | The scrambled bytes. Useless without the key. |
| **Plaintext** | The original bytes, before scrambling (or after unscrambling). |
| **WebRTC** | The browser feature that sends live audio and video between computers. The object that does it is `RTCPeerConnection`. |
| **SFU** | A server (Vonage’s) that receives your media and forwards a copy to everyone else. It routes packets. With this cipher, it cannot watch them. |
| **Worker** | A background JavaScript thread. All the actual encrypt and decrypt work runs there, so the page stays responsive. |
| **Browser API** | A function the browser itself provides (`crypto.subtle`, `RTCPeerConnection`, `Worker`, …). We call those. We do not ship our own AES code. |

---

## 3. Who does what

Three programs are involved. Only one of them can read the video.

```
YOUR BROWSER                          VONAGE                         THEIR BROWSER
─────────────                         ──────                         ─────────────
camera
  → encode (browser)
  → SEAL  (frame-cipher worker)  →   forwards ciphertext   →   OPEN (their worker)
                                                                  → decode
                                                                  → screen
```

| Piece | What it is allowed to see |
| --- | --- |
| **Your page** (`src/lib/media-cipher.ts`, or `packages/call-surface`) | The passphrase you type. It turns that into 32 bytes and hands them to the cipher. It never sends those bytes to our server. |
| **`@booth/frame-cipher`** | The 32 bytes, and every frame. This is the only code that encrypts and decrypts. |
| **Our Next.js server** (`/api/rooms`) | Your name and the room name. It asks Vonage for a session id and a token. It never sees the key or the media. |
| **Vonage** | The session, who joined, packet sizes, and the ciphertext. It cannot play the video. |

---

## 4. The call, step by step

There are two apps that use the same library:

- The website: `src/components/call-room.tsx` → `src/lib/media-cipher.ts`
- The page inside the mobile app: `packages/call-surface/src/main.ts` → `packages/call-surface/src/cipher.ts`

Both follow the same seven steps. Function names below are the website’s. The mobile page uses the same cipher functions under shorter names (`cipher.arm`, `cipher.enableEncryption`).

### Step 0 — You open the room. Nothing is encrypted yet.

The call is designed to start in the clear. Encryption is something a person turns on, by typing a passphrase, after they are already talking. Until then every frame is forwarded unchanged.

### Step 1 — Install the cipher **before** the video SDK loads

`CallRoom` calls `armMediaCipher(room)` and only then does `import("@vonage/client-sdk-video")`.

`armMediaCipher` (`src/lib/media-cipher.ts`) does three things:

1. `frameCipherSupport()` — asks the browser “can you do this at all?”
2. `createFrameCipher({ key: null, headerPolicy: "sfu", forwardSecrecy: true })` — builds the cipher with **no key**.
3. `cipher.install()` — patches `RTCPeerConnection` so every future audio/video track gets a transform.

Why the order matters: when the Vonage SDK’s file loads, it **copies** the methods on `RTCPeerConnection.prototype` and keeps those copies. If we patch after that copy, Vonage keeps calling the original methods and our encryption is never attached. No error is thrown. The call just stays in the clear. So `install()` must run first, and the SDK must be loaded with a dynamic `import()`, not a top-level import.

`frameCipherSupport()` looks for four things. Any one missing and it refuses, rather than sending plaintext by accident:

| Check | Browser API | If it is missing |
| --- | --- | --- |
| We are in a browser | `window` | Node and React Native cannot run the cipher. |
| WebRTC exists | `RTCPeerConnection` | This browser cannot make a call. |
| Encoded-frame transforms exist | `RTCRtpScriptTransform` | Needs Chrome/Edge 141+, Firefox 117+, or Safari 15.4+. |
| Background threads exist | `Worker` | The crypto has nowhere to run. |

### Step 2 — Vonage builds the call. We hook every track.

Vonage creates an `RTCPeerConnection` and adds your camera and microphone. Because `install()` replaced these methods, each one also calls our `attach()`:

| Patched method | When Vonage calls it | What we do |
| --- | --- | --- |
| `RTCPeerConnection.prototype.addTrack` | Camera or mic is added | `attach("encrypt", sender)` on the outgoing track |
| `RTCPeerConnection.prototype.addTransceiver` | A send/receive pipe is created | Encrypt the sender side, decrypt the receiver side |
| `setLocalDescription` / `setRemoteDescription` | The browsers agree how to talk (SDP) | `armPeerConnection()` walks every sender and receiver and attaches anything we missed |
| `RTCRtpSender.prototype.setParameters` | Vonage sets bitrate | Unrelated to crypto. Chrome rejects some fields Vonage sends; we merge them into the live parameters so bitrate control still works. |

`attach()` is the function that actually connects encryption to a track. It does one assignment:

```ts
endpoint.transform = new RTCRtpScriptTransform(worker, { op, kind, ...key material });
```

- `endpoint` is an `RTCRtpSender` (your outgoing audio or video) or an `RTCRtpReceiver` (theirs, incoming).
- `op` is `"encrypt"` for a sender and `"decrypt"` for a receiver.
- `RTCRtpScriptTransform` is the browser API that says: “every encoded frame on this track must pass through this worker before it is sent, or before it is decoded.”

The first call to `attach()` also starts the worker (`ensureWorker()`):

1. `new Blob([WORKER_SOURCE])` — the crypto program is a string inside the package (`src/worker-source.ts`). We do not ask you to copy a file into `public/`.
2. `URL.createObjectURL(blob)` — turns that string into a URL the browser can load.
3. `new Worker(url)` — starts it on a background thread.

From then on the main page and the worker talk with `worker.postMessage`. The page sends “here is the key” and “advance the ratchet.” The worker sends back “frame sealed,” “frame dropped,” and counters.

### Step 3 — Frames flow, still in the clear

The browser encoder emits a frame. The browser fires `self.onrtctransform` inside the worker and gives it a stream:

- `transformer.readable` — frames coming in (encoded, not yet sent, or just received).
- `transformer.writable` — frames going out (to the network, or to the decoder).

The worker’s `pump()` loop reads one frame, calls either `sealFrame` or `openFrame`, then writes the result.

With no key, `sealFrame` returns the original bytes and marks the reason `"plaintext"`. `openFrame` does the same for anything that does not carry our marker. The call looks like a normal Vonage call.

### Step 4 — Someone turns encryption on

In the website this is the form in `src/components/encryption-control.tsx`. Two ways in:

| What you type | App function | What it does |
| --- | --- | --- |
| A passphrase (words) | `enableEncryption(passphrase)` | `deriveKeyFromPassphrase(passphrase, roomName)` then `cipher.setKey(key)` |
| A pasted key (base64 or hex) | `enableEncryptionWithKey(value)` | `parseKeyInput(value)` then `cipher.setKey(key)` |

`setKey` does **not** renegotiate the call. It `postMessage`s `{ type: "cipher-key", rootSecret }` to the worker. The next frame is sealed. The one before it was not. Video keeps playing.

The room name is the salt (see PBKDF2 below). The same words in two different rooms produce two different keys.

### Step 5 — The worker turns 32 bytes into real AES keys

The 32 bytes are **not** the AES key. `KeySchedule` (inside the worker) derives everything with HKDF. Detail is in section 6. The result, per person, per audio-or-video, per generation:

- an AES-GCM `CryptoKey` the page cannot export
- a 12-byte nonce base
- a 2-byte `keyId` you can show on screen (`"941a"`) so both people can confirm they typed the same secret

### Step 6 — Each outgoing frame is sealed

`sealFrame` runs once per frame on a sender:

1. Leave a few header bytes readable so Vonage can still tell a keyframe from a normal frame and route the packet. Default `headerPolicy: "sfu"` keeps 1 byte for audio, 3 bytes for a video delta frame, 10 bytes for a video keyframe.
2. Build a trailer (who sent it, a counter, the generation, the header length, the key id, a 4-byte magic marker `b0 07 11 20`).
3. `crypto.subtle.encrypt` with **AES-GCM** over the rest of the frame. The readable header and the trailer are passed as `additionalData`, so changing any of them makes decryption fail.
4. Write back: `[clear header][ciphertext + 16-byte tag][trailer]`.

Overhead is 35 bytes per frame (16-byte tag + 19-byte trailer). At 30 fps that is about 1 KB/s.

### Step 7 — The other browser opens the frame, or drops it

`openFrame` runs once per frame on a receiver:

| What it sees | Function result | What you see |
| --- | --- | --- |
| No magic marker | Pass the bytes through | Normal video. They have not turned encryption on. |
| Magic marker, and we have no key | Return `null` (drop). Reason `"locked"`. | A lock, not a smeared picture. Ciphertext is never given to the decoder. |
| Magic marker, different secret | Drop. Reason `"key-mismatch"`. | “Someone is using a different secret.” |
| Magic marker, same secret, tag checks out | `crypto.subtle.decrypt`, glue the clear header back on, write the frame | The picture returns. |
| Same frame seen again | Drop. Reason `"replayed"`. | Nothing. A copied packet cannot be played twice. |
| Tag check throws | Drop. Counted as `failed`. | A modified frame is rejected. |

When frames start coming out again after a gap (you just typed the passphrase, they just turned encryption on), the worker calls `sendKeyFrameRequest()` on the receiver and `generateKeyFrame()` on the sender. A video decoder cannot paint from a half-stream; it needs a full keyframe. We ask for one immediately instead of waiting for the camera’s normal interval.

### Step 8 — Someone joins or leaves

`call-room.tsx` listens to Vonage `connectionCreated` and `connectionDestroyed` and calls `rekeyOnMembershipChange()`. If we currently hold a key, that calls `cipher.ratchet()`.

`ratchet()` tells the worker “move to the next generation.” The worker derives a new key with HKDF from the previous one, and **throws away** keys older than the grace window (default: keep the last 2). Frames already in flight still decrypt. Frames from a generation we have forgotten cannot be decrypted, including by someone who later steals the worker’s memory.

Every participant must ratchet on the same event. If one side moves forward and the other does not, frames are counted as `staleGeneration` and dropped.

### Step 9 — Turning it off

`forgetKey()` calls `cipher.setKey(null)`. The worker wipes the schedule. We stop sealing, and we can no longer read anyone who is still sealing. There is no “keep the key but send in the clear” button: that would make your own screen look locked while your camera went out unprotected.

`cipher.destroy()` (on leaving the page) posts `cipher-shutdown`, calls `worker.terminate()`, revokes the blob URL, and puts the original `RTCPeerConnection` methods back.

---

## 5. Browser APIs, which function calls them, and why

Nothing here is a native addon. Every cryptographic operation is the browser’s own Web Crypto implementation.

### Randomness — `crypto.getRandomValues`

| Function | File | What the random bytes are |
| --- | --- | --- |
| `generateMediaKey()` | `src/keys.ts` | The 32-byte call secret, when you click “generate a key” instead of typing a passphrase. |
| `createFrameCipher()` | `src/cipher.ts` | A 4-byte `senderId`, so each person gets their own AES key and their own counter. Two people must not share this id. |
| `createFrameCipher()` | `src/cipher.ts` | `crypto.randomUUID()` — an id for this cipher instance, so messages to the worker are not mixed up if two exist. |

`getRandomValues` is a CSPRNG: output you cannot predict or recover. React Native does not have it unless you import `react-native-get-random-values` first. The frame transform itself cannot run on React Native at all (`RTCRtpScriptTransform` does not exist there).

### Key stretching — `crypto.subtle` PBKDF2

| Function | Algorithm | Inputs |
| --- | --- | --- |
| `deriveKeyFromPassphrase(phrase, room)` | **PBKDF2-SHA-256**, 600,000 rounds | The passphrase, normalized with `NFKC`, and the salt `frame-cipher/v2/` + the room name. Output: 32 bytes. |

A passphrase like “correct horse” is guessable. PBKDF2 runs SHA-256 hundreds of thousands of times so each guess is slow. The room name in the salt means the same words in another room are a different key.

Calls: `crypto.subtle.importKey("raw", …, "PBKDF2")` then `crypto.subtle.deriveBits(...)`.

This runs on the page, in `enableEncryption`, **before** `setKey`. The worker never sees the passphrase, only the 32 bytes.

### Key derivation — `crypto.subtle` HKDF, inside the worker

Function: `hkdf()` in `src/worker-source.ts`, used only by `KeySchedule`.

Algorithm: **HKDF-SHA-256**.

HKDF is a one-way mixer. Give it a secret plus a label, get new bytes. You cannot go backwards.

| Call | Label (`info`) | Salt | Output |
| --- | --- | --- | --- |
| `KeySchedule.init` | `"fc/v2/gen0"` | empty | generation 0, 32 bytes, from the root secret |
| `deriveStep` | `"fc/v2/ratchet"` | empty | generation n+1 from generation n. One-way. |
| `materialise` | `"fc/v2/keyid"` | empty | 2 bytes shown in the UI as `keyId` |
| `deriveSender` | `"fc/v2/sender/audio"` or `"fc/v2/sender/video"` | the 4-byte `senderId` | 32-byte AES key + 12-byte nonce base |

After generation 0 exists, `init` zeroes the root (`forwardSecrecy: true`, the default). The worker can go forward to generation 1, 2, 3. It cannot rebuild generation 0.

`deriveSender` then does:

```text
crypto.subtle.importKey("raw", aesKeyBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"])
```

The `false` means **non-extractable**. JavaScript cannot read the AES key back out. `wipe()` fills the byte arrays with zeroes when a generation is forgotten or the call ends.

### The actual lock — `crypto.subtle.encrypt` / `decrypt`

| Function | API | Algorithm |
| --- | --- | --- |
| `sealFrame` | `crypto.subtle.encrypt` | **AES-GCM**, 128-bit authentication tag |
| `openFrame` | `crypto.subtle.decrypt` | same |

AES-GCM does two jobs at once:

1. **Confidentiality.** The frame body is scrambled. Vonage sees noise.
2. **Integrity.** A 16-byte tag is appended. If anyone flips a bit in the ciphertext, the header, the counter, or the generation, `decrypt` throws and we drop the frame.

Parameters passed in:

| Field | Value | Why |
| --- | --- | --- |
| `name` | `"AES-GCM"` | The only mode this package uses. A mode without a tag would turn tampering into a glitchy picture, which looks like a network bug. |
| `iv` | `nonceFor(nonceBase, counter)` | 12 bytes. `nonceBase XOR counter`. The counter is 48 bits and only ever increases, so the same nonce is never used twice with the same key. Reusing an AES-GCM nonce does not just leak the frame — it leaks the authentication key. |
| `additionalData` | clear header + trailer | Encrypted-not, but covered by the tag. This is how the readable SFU header stays honest. |
| `tagLength` | 128 | 16-byte tag. |

The nonce is **not** written on the wire. Both sides recompute it from `nonceBase` (derived) and `counter` (in the trailer).

### Fingerprint — SHA-256, written in JavaScript

| Function | What |
| --- | --- |
| `mediaKeyFingerprint` / `mediaKeyFingerprintSync` | SHA-256 of the 32-byte secret, first 2 bytes, printed as four hex characters (`"941a"`). |

This SHA-256 lives in `src/keys.ts` as plain code, not `crypto.subtle`, so the same four characters come out on the web, in Node, and on React Native. It is safe to show. It is not the key.

The worker’s `keyId` is a different 2-byte value (HKDF, and it changes when you ratchet). The passphrase fingerprint does not. Both are “do we match?” checks. They answer slightly different questions: fingerprint = same secret, `keyId` = same secret **and** same generation.

### The WebRTC hook

| API | Where | Role |
| --- | --- | --- |
| `RTCPeerConnection` | `install`, `armPeerConnection` | The call itself. We patch its prototype. |
| `RTCRtpSender` / `RTCRtpReceiver` | `attach` | One per outgoing or incoming track. We set `.transform`. |
| `RTCRtpScriptTransform` | `attach` | Tells the browser to run our worker on every encoded frame. |
| `self.onrtctransform` | worker | Browser entry point. Gives us `readable` and `writable` streams of `RTCEncodedVideoFrame` / `RTCEncodedAudioFrame`. |
| `transformer.readable.getReader()` | `pump` | Pull the next frame. |
| `transformer.writable.getWriter()` | `pump` | Push the sealed or opened frame onward. |
| `frame.data` | `pump` | The bytes. We replace this `ArrayBuffer`. We do not touch the encoder or the decoder. |
| `frame.type` | `sealFrame` via `headerLength` | `"key"` or `"delta"`. Decides how many header bytes stay readable. |
| `generateKeyFrame()` | `askForKeyFrame`, encrypt side | Ask the encoder for a fresh full frame. |
| `sendKeyFrameRequest()` | `askForKeyFrame`, decrypt side | Ask the other side’s encoder for one (RTCP PLI). |

### Worker plumbing

| API | Where | Role |
| --- | --- | --- |
| `Blob` + `URL.createObjectURL` | `ensureWorker` | Ship the worker with no extra file. |
| `Worker` | `ensureWorker` | The thread that runs `WORKER_SOURCE`. |
| `postMessage` | `setKey`, `ratchet`, `setSending`, `destroy`, and the worker’s `post()` | The only channel between page and crypto. |
| `performance.now()` | worker | Timing, and a 1-second cooldown on keyframe requests. |

### Things the cipher does **not** call

`navigator.mediaDevices.getUserMedia` is how the page opens the camera and microphone. That happens inside the Vonage SDK (and, in the mobile WebView, in `probeMedia`). The cipher never touches the camera. It only sees frames after the browser has already encoded them.

`fetch("/api/rooms")` gets a Vonage token. It carries the room name and your display name. It does not carry the key.

---

## 6. Algorithms, one by one

Only these. No RSA, no AES-CTR, no hand-rolled cipher.

| # | Algorithm | Job | Function |
| --- | --- | --- | --- |
| 1 | CSPRNG (`crypto.getRandomValues`) | Make the secret and the sender id unpredictable | `generateMediaKey`, `createFrameCipher` |
| 2 | PBKDF2-SHA-256, 600k rounds | Turn a typed passphrase into 32 bytes, slowly | `deriveKeyFromPassphrase` |
| 3 | HKDF-SHA-256 | Turn those 32 bytes into per-generation, per-sender AES keys, and into the public `keyId` | `hkdf` → `KeySchedule` |
| 4 | AES-256-GCM | Scramble the frame and attach a tag | `sealFrame`, `openFrame` |
| 5 | SHA-256 (first 2 bytes) | A short public fingerprint of the secret | `mediaKeyFingerprint` |
| 6 | base64url | Turn 32 bytes into a string you can paste. Not encryption. | `encodeMediaKey`, `decodeMediaKey` |

“AES-256” because `importKey` is given 32 bytes. GCM is the mode. The tag is 128 bits.

### How the nonce stays unique

```
iv = nonceBase XOR (six zero bytes ‖ 48-bit counter)
```

`nonceBase` is different for every sender and every media kind (audio has its own, video has its own), because the HKDF salt is `senderId` and the label includes `"audio"` or `"video"`. The counter starts at 0 and increments by 1 for every frame that sender seals under that key. A nonce repeats only if one sender reuses a counter under one key. The code never does that.

### Replay window

`replayCheck` / `replayRecord` keep a 1024-bit bitmap of recently seen counters, per sender, per generation. A frame is only recorded **after** the GCM tag verifies, so a forged frame cannot punch a hole in the window. A counter older than 1024 behind the newest, or already seen, is dropped.

### The bytes on the wire

```
[ clear header ][ ciphertext ‖ 16-byte GCM tag ][ trailer ]
  0, 1, 3, or 10 bytes                         19 bytes
```

Trailer layout, in order:

| Field | Bytes | Meaning |
| --- | --- | --- |
| `senderId` | 4 | Which participant sealed this. Also the HKDF salt for their key. |
| `counter` | 6 | Frame number for the nonce and the replay window. |
| `generation` | 1 | Which ratchet step. 0, then 1, then 2, … |
| `flags` | 1 | `0x01` when the whole frame is encrypted (`headerPolicy: "full"`). |
| `headerLen` | 1 | How many leading bytes were left in the clear. Must be 0, 1, 3, or 10. |
| `keyId` | 2 | HKDF tag for this generation. Mismatch → drop. |
| `magic` | 4 | `b0 07 11 20`. “This frame was sealed by frame-cipher.” Anything else passes through. |

`headerPolicy: "sfu"` (what the app sets) leaves the codec header readable so Vonage can still route the packet. Those bytes are authenticated by the GCM tag, so Vonage can **read** them and cannot **change** them without the frame being dropped. `headerPolicy: "full"` encrypts the header too. The app does not use that: the receiver then mis-counts keyframes and recovers more slowly after packet loss.

---

## 7. Function map

Follow a passphrase from the text box to a decrypted frame.

```
encryption-control.tsx
  enableEncryption(passphrase)                  src/lib/media-cipher.ts
    deriveKeyFromPassphrase(phrase, room)       src/keys.ts
      crypto.subtle  PBKDF2-SHA-256  → 32 bytes
    cipher.setKey(bytes)                        src/cipher.ts
      worker.postMessage({ type: "cipher-key" })

worker  (src/worker-source.ts, running inside a Worker)
  KeySchedule
    hkdf  HKDF-SHA-256
      gen0, then ratchet, then per-sender AES key
    crypto.subtle.importKey  AES-GCM  (non-extractable)

  onrtctransform → pump
    sender:  sealFrame → crypto.subtle.encrypt  AES-GCM
    receiver: openFrame → crypto.subtle.decrypt AES-GCM
                          replayCheck / replayRecord
```

Install path, which happens earlier, with no key:

```
call-room.tsx
  armMediaCipher(room)                          src/lib/media-cipher.ts
    frameCipherSupport()                        src/cipher.ts
    createFrameCipher({ key: null })
    cipher.install()
      patches RTCPeerConnection.prototype
  import("@vonage/client-sdk-video")            only after install()
    Vonage calls addTrack / setLocalDescription
      attach()
        new RTCRtpScriptTransform(worker, …)
          browser calls onrtctransform
```

Membership:

```
connectionCreated / connectionDestroyed
  rekeyOnMembershipChange()                     src/lib/media-cipher.ts
    cipher.ratchet()                            only if hasKey
      worker: KeySchedule.ratchetTo
        hkdf(previous, "fc/v2/ratchet")
        forget generations behind the grace window
```

---

## 8. What “end to end” covers here, and where it stops

**Covered.** Vonage, our API server, and anyone on the network path see ciphertext for audio and video. A flipped bit fails the GCM tag and the frame is dropped. A resent packet fails the replay window. After a ratchet, the worker cannot rebuild older keys.

**Still visible.** Who is in the room, when, how long, packet sizes, and the few codec-header bytes we leave clear so the SFU can route. Those headers say “this is a keyframe” and roughly how the frame is shaped. They are not the picture.

**A person who has the passphrase** is a full participant. `senderId` is chosen by the sender, so that person can seal frames that claim to be someone else. Stopping that would take a signature on every frame. This package does not add one.

**A leaked passphrase** still decrypts. The ratchet protects the worker’s memory after the fact. It does not protect a passphrase you said out loud or pasted in chat, because anyone with it can derive generation 0 again and walk forward.

**Whoever serves the JavaScript** can, in principle, serve different JavaScript that steals the key. That limit is true of every browser E2E app. The cipher never sends the key anywhere; the page you loaded is the trust boundary.
