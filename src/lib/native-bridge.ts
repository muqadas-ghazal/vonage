"use client";

import { frameCipherSupport } from "@booth/frame-cipher";
import {
  installPageBridge,
  isHosted,
  trackStateFrom,
  type SealedTrack,
} from "@booth/sealed-call-native/web";

import {
  cipherState,
  enableEncryption,
  enableEncryptionWithKey,
  forgetKey,
  keyStringFingerprint,
  mediaCipher,
  passphraseFingerprint,
  setCipherVerbose,
  subscribeCipherState,
  trackEncryption,
} from "./media-cipher";

/**
 * Connects the call page to the React Native shell, when there is one.
 *
 * On the web this is a no-op — `isHosted()` is false and nothing is installed. Inside the
 * WebView it hands the shell the cipher's state and takes keys back, so the lock badges,
 * locked-tile overlays and passphrase screens can be native components while the crypto
 * stays here, where `RTCRtpScriptTransform` exists.
 */
export function installNativeBridge(): () => void {
  if (!isHosted()) return () => {};

  return installPageBridge({
    support() {
      const support = frameCipherSupport();
      return support.supported
        ? { supported: true }
        : { supported: false, reason: support.reason };
    },

    async enablePassphrase(value) {
      await enableEncryption(value);
    },

    enableRawKey(value) {
      enableEncryptionWithKey(value);
    },

    forgetKey,

    setVerbose(value) {
      setCipherVerbose(value);
    },

    snapshot() {
      const state = cipherState();
      return {
        hasKey: state.hasKey,
        sending: state.sending,
        keyId: state.keyId,
        generation: state.generation,
        lockedStreams: state.lockedStreams,
        securedStreams: state.securedStreams,
        plaintextStreams: state.plaintextStreams,
      };
    },

    tracks() {
      const cipher = mediaCipher();
      if (!cipher) return [];
      const seen = new Set<string>();
      const tracks: SealedTrack[] = [];
      for (const stream of cipher.getStreams()) {
        // Inbound only: a tile shows how a *peer's* media is arriving. Our own outbound
        // streams say nothing about what the user is looking at.
        if (stream.op !== "decrypt" || !stream.trackId) continue;
        if (seen.has(stream.trackId)) continue;
        seen.add(stream.trackId);
        tracks.push({
          trackId: stream.trackId,
          kind: stream.kind,
          state: trackStateFrom(trackEncryption(stream.trackId)),
        });
      }
      return tracks;
    },

    subscribe: subscribeCipherState,

    fingerprint(value, mode) {
      return mode === "passphrase" ? passphraseFingerprint(value) : keyStringFingerprint(value);
    },
  });
}
