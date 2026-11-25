import {
  installPageBridge,
  postPageError,
  postPageMedia,
  postPageStatus,
  PAGE_STATUS_IN_CALL,
  trackStateFrom,
  type SealedTrack,
} from "@booth/sealed-call-native/web";

import * as cipher from "./cipher";
import { join, readConfig } from "./config";

type OTApi = typeof import("@vonage/client-sdk-video");
type Session = ReturnType<OTApi["initSession"]>;
type Stream = Parameters<Session["subscribe"]>[0];

const grid = document.getElementById("grid") as HTMLDivElement;
const fatal = document.getElementById("fatal") as HTMLDivElement;
const statusLine = document.getElementById("status") as HTMLDivElement;

/** Progress, shown on the page. A silent black WebView is the hardest thing to debug. */
function status(text: string) {
  statusLine.textContent = text;
  statusLine.dataset.done = "";
  // Also to the shell: if the WebView is not painting, the page's own text is invisible.
  postPageStatus(text);
}

function statusDone() {
  statusLine.dataset.done = "1";
  postPageStatus(PAGE_STATUS_IN_CALL);
}

/** Every tile on screen, so cipher state can be painted onto the right one. */
const tiles = new Map<string, HTMLDivElement>();

/**
 * Set once the publisher exists. The bridge is installed before that — it must be ready
 * for a key the moment the page loads — so the resume hook reads this when it fires
 * rather than capturing it.
 */
let recoverVideo: (() => Promise<void>) | null = null;

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name} — ${error.message}`;
  const value = error as { name?: string; message?: string } | null;
  if (value && (value.name || value.message)) return `${value.name ?? "error"} — ${value.message ?? ""}`;
  return String(error);
}

function die(message: string) {
  fatal.textContent = message;
  fatal.dataset.show = "1";
  statusDone();
  // Also tell the shell, or the failure exists only in a DOM node nobody can see.
  postPageError(message);
}

function addTile(id: string): HTMLDivElement {
  const tile = document.createElement("div");
  tile.className = "tile";
  tile.dataset.id = id;
  grid.append(tile);
  tiles.set(id, tile);
  grid.dataset.count = String(tiles.size);
  return tile;
}

function removeTile(id: string) {
  tiles.get(id)?.remove();
  tiles.delete(id);
  grid.dataset.count = String(tiles.size);
}

/** The media track ids behind a tile, which is how a tile asks the cipher about itself. */
function trackIdsOf(tile: HTMLElement): string[] {
  const video = tile.querySelector("video");
  const source = video?.srcObject;
  if (!(source instanceof MediaStream)) return [];
  return source.getTracks().map((track) => track.id);
}

/**
 * Repaints every remote tile from the cipher's view of its tracks.
 *
 * A locked tile is blanked rather than left showing a frozen frame, because "locked" and
 * "stalled" look identical otherwise and only one of them is a security state.
 */
function paint() {
  for (const [id, tile] of tiles) {
    if (id === "self") continue;
    let next: string = "clear";
    for (const trackId of trackIdsOf(tile)) {
      const state = trackStateFrom(cipher.trackEncryption(trackId));
      // Locked wins: if any track of this tile is unreadable, that is the fact to show.
      if (state === "locked") { next = "locked"; break; }
      if (state === "sealed") next = "sealed";
    }
    tile.dataset.state = next;
  }
}

/** Per-track states for the native shell's own badges. */
function tracks(): SealedTrack[] {
  const seen = new Set<string>();
  const out: SealedTrack[] = [];
  for (const stream of cipher.streams()) {
    if (stream.op !== "decrypt" || !stream.trackId) continue;
    if (seen.has(stream.trackId)) continue;
    seen.add(stream.trackId);
    out.push({
      trackId: stream.trackId,
      kind: stream.kind,
      state: trackStateFrom(cipher.trackEncryption(stream.trackId)),
    });
  }
  return out;
}

async function loadOT(): Promise<OTApi> {
  const loaded = (await import("@vonage/client-sdk-video")) as OTApi & { default?: OTApi };
  return loaded.default ?? loaded;
}

/** What the WebView can actually see and open. */
type MediaProbe = {
  audio: string;
  video: string;
  report: string;
  /**
   * A live microphone track obtained with processing disabled, when the default
   * constraints failed but relaxed ones worked. Handed straight to the publisher.
   */
  audioTrack: MediaStreamTrack | null;
};

/**
 * Asks the WebView directly what media it can see and open.
 *
 * Vonage requests audio and video in one call and reports a single combined failure, so a
 * microphone that cannot be opened looks exactly like a camera that cannot be opened.
 * Testing each kind separately is the only way to tell them apart — and it decides which
 * track to fall back to, which the combined error cannot.
 *
 * Each track is stopped immediately, and the caller waits before publishing, so the probe
 * cannot be what holds the hardware.
 */
async function probeMedia(): Promise<MediaProbe> {
  const parts: string[] = [];

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter((device) => device.kind === "videoinput");
    const microphones = devices.filter((device) => device.kind === "audioinput");
    // Empty labels mean the page has not been granted access, which is a different
    // problem from hardware that cannot be opened.
    const labelled = cameras.some((device) => device.label.length > 0);
    parts.push(`cams=${cameras.length} mics=${microphones.length} labels=${labelled ? "yes" : "no"}`);
  } catch (error) {
    parts.push(`enumerate=${describe(error)}`);
  }

  const attempt = async (constraints: MediaStreamConstraints): Promise<string> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      for (const track of stream.getTracks()) track.stop();
      return "ok";
    } catch (error) {
      return error instanceof Error ? error.name : String(error);
    }
  };

  let audio = await attempt({ audio: true });
  const video = await attempt({ video: true });

  // Hardware contention is often momentary — a previous holder releasing late. One retry
  // separates "busy right now" from "cannot be opened at all".
  if (audio !== "ok") {
    await new Promise((resolve) => setTimeout(resolve, 800));
    const second = await attempt({ audio: true });
    audio = second === "ok" ? "ok (after retry)" : `${audio}/${second}`;
  }

  // Default audio constraints ask for the hardware echo canceller, which on Android goes
  // through VOICE_COMMUNICATION capture. When that path is unavailable the request fails
  // with NotReadableError even though the microphone itself is free — raw audio opens.
  // The track is kept alive rather than stopped, because the publisher will use it.
  let audioTrack: MediaStreamTrack | null = null;
  if (!audio.startsWith("ok")) {
    try {
      const raw = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      audioTrack = raw.getAudioTracks()[0] ?? null;
      for (const track of raw.getVideoTracks()) track.stop();
      parts.push(audioTrack ? "raw-audio=ok" : "raw-audio=no-track");
    } catch (error) {
      parts.push(`raw-audio=${error instanceof Error ? error.name : String(error)}`);
    }
  }

  parts.push(`audio=${audio}`, `video=${video}`);
  return { audio, video, report: parts.join(" · "), audioTrack };
}

async function main() {
  status("Reading settings…");
  const config = readConfig();

  // Before anything else: the cipher patches RTCPeerConnection, and only sees connections
  // created after it is installed. The Vonage SDK must not run first.
  cipher.arm(config.room);

  // Hand the shell the cipher's state and take keys back. A no-op in a plain browser.
  installPageBridge({
    support: () => {
      const value = cipher.support();
      return value.supported ? { supported: true } : { supported: false, reason: value.reason };
    },
    enablePassphrase: cipher.enableEncryption,
    enableRawKey: cipher.enableEncryptionWithKey,
    forgetKey: cipher.forgetKey,
    setVerbose: cipher.setVerbose,
    snapshot: () => {
      const { hasKey, sending, keyId, generation, lockedStreams, securedStreams, plaintextStreams } =
        cipher.state();
      return { hasKey, sending, keyId, generation, lockedStreams, securedStreams, plaintextStreams };
    },
    tracks,
    subscribe: cipher.subscribe,
    fingerprint: (value, mode) =>
      mode === "passphrase" ? cipher.passphraseFingerprint(value) : cipher.keyStringFingerprint(value),
    onResume: () => recoverVideo?.(),
  });

  cipher.subscribe(paint);

  status(`Joining ${config.room}…`);
  const credentials = await join(config);

  status("Loading the video SDK…");
  const OT = await loadOT();

  const session: Session = OT.initSession(credentials.apiKey, credentials.sessionId);

  session.on("streamCreated", (event: { stream: Stream }) => {
    const id = event.stream.streamId;
    const tile = addTile(id);
    session.subscribe(
      event.stream,
      tile,
      { insertMode: "append", width: "100%", height: "100%" },
      (error) => {
        if (error) removeTile(id);
        // The track only exists once the subscriber is wired up, so paint after it lands.
        else setTimeout(paint, 0);
      },
    );
  });

  session.on("streamDestroyed", (event: { stream: Stream }) => removeTile(event.stream.streamId));
  session.on("connectionCreated", () => cipher.rekeyOnMembershipChange());
  session.on("connectionDestroyed", () => cipher.rekeyOnMembershipChange());
  session.on("sessionDisconnected", () => die("The call ended."));

  status("Connecting…");
  await new Promise<void>((resolve, reject) => {
    session.connect(credentials.token, (error) => (error ? reject(new Error(error.message)) : resolve()));
  });

  status("Checking the camera and microphone…");
  const probe = await probeMedia();
  postPageMedia(probe.report);
  // Give the hardware a moment to be released before Vonage asks for it.
  await new Promise((resolve) => setTimeout(resolve, 400));

  const audioWorks = probe.audio.startsWith("ok") || probe.audioTrack !== null;
  const videoWorks = probe.video.startsWith("ok");
  if (!audioWorks && !videoWorks) {
    die(
      `Neither the microphone nor the camera could be opened (${probe.report}). ` +
        "Close any other app using them, or restart the device, then rejoin.",
    );
    return;
  }

  status("Asking for the camera and microphone…");

  const selfTile = addTile("self");

  /**
   * Builds a publisher, optionally without video.
   *
   * The element is emptied first because `insertMode: "append"` would otherwise stack a
   * second video element on a retry.
   */
  const makePublisher = (withAudio: boolean, withVideo: boolean) =>
    new Promise<ReturnType<OTApi["initPublisher"]>>((resolve, reject) => {
      selfTile.replaceChildren();
      const created = OT.initPublisher(
        selfTile,
        {
          insertMode: "append",
          width: "100%",
          height: "100%",
          mirror: true,
          // A track we opened ourselves, when the default constraints would not work.
          ...(withAudio
            ? probe.audioTrack
              ? { audioSource: probe.audioTrack }
              : {}
            : { audioSource: null }),
          ...(withVideo ? {} : { videoSource: null }),
        },
        (error) => {
          if (!error) {
            resolve(created);
            return;
          }
          // A publisher that failed may already hold one of the two devices — Vonage
          // acquires them separately. Leaving it alive keeps that device locked, so every
          // later attempt fails too, including after a reload. Destroying it is the only
          // way the hardware comes back without killing the app.
          try {
            created.destroy();
          } catch {
            // Already torn down by the SDK; nothing to release.
          }
          reject(error);
        },
      );
    });

  /**
   * The camera exists but something else holds it — another app, or this app's own
   * previous instance that has not released it yet. Distinct from a permission denial,
   * and usually temporary, so it is worth retrying rather than failing the call.
   */
  const hardwareBusy = (error: unknown) => {
    const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
    return /NotReadableError|HARDWARE_UNAVAILABLE|TrackStartError|AbortError/i.test(text);
  };

  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  let publisher: ReturnType<OTApi["initPublisher"]>;
  try {
    // Ask only for what the probe could open. Requesting a track the hardware will refuse
    // fails the whole publisher, taking the working track down with it.
    publisher = await makePublisher(audioWorks, videoWorks);
    if (!audioWorks) {
      postPageStatus("Microphone unavailable — publishing video only.");
    } else if (!videoWorks) {
      postPageStatus("Camera unavailable — publishing audio only.");
    }
  } catch (first) {
    if (!hardwareBusy(first)) {
      die(`Could not open the camera or microphone: ${describe(first)}`);
      return;
    }
    status("The hardware is busy — retrying…");
    await wait(1500);
    try {
      publisher = await makePublisher(audioWorks, videoWorks);
    } catch (last) {
      die(
        `The camera or microphone is held by something else: ${describe(last)}. ` +
          "Close any other app using them, or restart the device, then rejoin.",
      );
      return;
    }
  }

  session.publish(publisher, (error) => {
    if (error) die(`Could not publish: ${error.name} — ${error.message}`);
    else statusDone();
  });

  /**
   * Re-acquires the camera after the app has been in the background.
   *
   * Both operating systems revoke camera access when an app leaves the foreground. If
   * they only *mute* the track it unmutes by itself on return, but when they *end* it
   * there is no recovery: an ended track never produces another frame, and the call
   * carries on with a frozen or black tile and no error anywhere.
   *
   * Audio is left alone deliberately — it keeps running in the background, so touching
   * it here would interrupt a call that is working.
   */
  recoverVideo = async () => {
    const source = publisher.getVideoSource();
    // A track the OS only muted unmutes itself; give it a moment before intervening,
    // because re-acquiring a healthy camera is a visible glitch for no reason.
    if (source.track && source.track.readyState === "live") {
      if (!source.track.muted) return;
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (publisher.getVideoSource().track?.readyState === "live" && !publisher.getVideoSource().track?.muted) {
        return;
      }
    }

    status("Restarting the camera…");
    try {
      let deviceId = source.deviceId;
      if (!deviceId) {
        const devices = await navigator.mediaDevices.enumerateDevices();
        deviceId = devices.find((device) => device.kind === "videoinput")?.deviceId ?? null;
      }
      if (!deviceId) throw new Error("no camera was found");
      await publisher.setVideoSource(deviceId);
      statusDone();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      // Not fatal: audio is still flowing and the call is still up.
      postPageStatus(`The camera did not come back: ${text}`);
    }
  };

  // Belt and braces: the shell drives this through the bridge on AppState, which is
  // authoritative, and the page also watches its own visibility in case the shell is a
  // plain browser tab.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void recoverVideo?.();
  });

  // Mobile browsers hold audio until a gesture; the shell has already had one by the time
  // the user reaches the call screen.
  void OT.unblockAudio();
}

main().catch((error: unknown) => {
  die(error instanceof Error ? error.message : String(error));
});
