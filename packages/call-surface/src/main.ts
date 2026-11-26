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
  /** A live camera track opened by the probe. Handed to the publisher so it does not ask again. */
  videoTrack: MediaStreamTrack | null;
};

/** How long a single capture may sit unanswered before we treat it as failed. */
const CAPTURE_TIMEOUT_MS = 8_000;

const rawAudio: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

function isAndroid(): boolean {
  return /Android/i.test(navigator.userAgent);
}

/**
 * `getUserMedia` on Android sometimes never settles. A timeout turns that into a result
 * the caller can fall past, instead of leaving the status line stuck.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error("timed out");
      error.name = "Timeout";
      reject(error);
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function failureName(error: unknown): string {
  if (error instanceof Error) {
    const name = error.name === "Error" ? "Error" : error.name;
    return error.message && error.message !== name ? `${name}: ${error.message}` : name;
  }
  return String(error);
}

async function capture(
  constraints: MediaStreamConstraints,
): Promise<{ name: string; stream: MediaStream | null }> {
  try {
    const stream = await withTimeout(navigator.mediaDevices.getUserMedia(constraints), CAPTURE_TIMEOUT_MS);
    return { name: "ok", stream };
  } catch (error) {
    return { name: failureName(error), stream: null };
  }
}

/** Keeps the first track of one kind and releases everything else in the stream. */
function keepTrack(stream: MediaStream, kind: "audio" | "video"): MediaStreamTrack | null {
  const tracks = kind === "audio" ? stream.getAudioTracks() : stream.getVideoTracks();
  const kept = tracks[0] ?? null;
  for (const track of stream.getTracks()) {
    if (track !== kept) track.stop();
  }
  return kept;
}

/**
 * Asks the WebView directly what media it can see and open.
 *
 * Vonage requests audio and video in one call and reports a single combined failure, so a
 * microphone that cannot be opened looks exactly like a camera that cannot be opened.
 * Testing each kind separately is the only way to tell them apart — and it decides which
 * track to fall back to, which the combined error cannot.
 *
 * On desktop the tracks are stopped so Vonage can open the devices itself. On Android the
 * tracks are kept: the default microphone constraints use voice-communication capture,
 * and that request can stay pending forever inside the WebView. Opening the camera on its
 * own, and the microphone with processing disabled, is what actually returns.
 */
async function probeMedia(): Promise<MediaProbe> {
  const parts: string[] = [];

  try {
    const devices = await withTimeout(navigator.mediaDevices.enumerateDevices(), CAPTURE_TIMEOUT_MS);
    const cameras = devices.filter((device) => device.kind === "videoinput");
    const microphones = devices.filter((device) => device.kind === "audioinput");
    // Empty labels mean the page has not been granted access, which is a different
    // problem from hardware that cannot be opened.
    const labelled = cameras.some((device) => device.label.length > 0);
    parts.push(`cams=${cameras.length} mics=${microphones.length} labels=${labelled ? "yes" : "no"}`);
  } catch (error) {
    parts.push(`enumerate=${failureName(error)}`);
  }

  let audio = "skipped";
  let video = "skipped";
  let audioTrack: MediaStreamTrack | null = null;
  let videoTrack: MediaStreamTrack | null = null;

  if (isAndroid()) {
    // Audio only, before the camera. A combined request was failing the microphone with
    // "Could not start audio source" on every constraint, while video alone succeeded.
    status("Opening the microphone…");
    try {
      const context = new AudioContext();
      await context.resume();
      await context.close();
      parts.push("audio-context=resumed");
    } catch (error) {
      parts.push(`audio-context=${failureName(error)}`);
    }

    const narrow = (sampleRate: number): MediaTrackConstraints => ({
      ...rawAudio,
      channelCount: 1,
      sampleRate,
    });
    const attempts: { label: string; constraints: MediaStreamConstraints }[] = [
      { label: "voice-16k", constraints: { audio: { channelCount: 1, sampleRate: 16000 } } },
      { label: "raw-16k", constraints: { audio: narrow(16000) } },
      { label: "raw-44k", constraints: { audio: narrow(44100) } },
      { label: "voice", constraints: { audio: true } },
      { label: "raw", constraints: { audio: rawAudio } },
    ];
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      for (const device of devices.filter((entry) => entry.kind === "audioinput" && entry.deviceId)) {
        attempts.push({
          label: `mic-${device.deviceId.slice(0, 4)}`,
          constraints: { audio: { deviceId: { exact: device.deviceId } } },
        });
      }
    } catch (error) {
      parts.push(`mic-ids=${failureName(error)}`);
    }

    let last = "skipped";
    for (const attempt of attempts) {
      const result = await capture(attempt.constraints);
      last = result.name;
      parts.push(`${attempt.label}=${result.stream ? "ok" : result.name}`);
      status(`Microphone ${attempt.label}: ${result.stream ? "opened" : result.name}`);
      if (!result.stream) continue;
      audioTrack = keepTrack(result.stream, "audio");
      if (audioTrack) {
        audio = "ok";
        break;
      }
    }

    // Automatic capture is not a user gesture. Some Android WebViews refuse to start
    // the audio recorder until the tap happens inside the page itself.
    if (!audioTrack) {
      status("Tap the video area to start the microphone");
      await new Promise<void>((resolve) => {
        const start = () => {
          document.removeEventListener("pointerdown", start);
          resolve();
        };
        document.addEventListener("pointerdown", start, { once: true });
      });
      const result = await capture({ audio: true });
      last = result.name;
      parts.push(`gesture=${result.stream ? "ok" : result.name}`);
      status(`Microphone gesture: ${result.stream ? "opened" : result.name}`);
      if (result.stream) audioTrack = keepTrack(result.stream, "audio");
    }

    if (!audioTrack) audio = last;
    status("Opening the camera…");
    const videoAttempt = await capture({ video: true });
    if (videoAttempt.stream) {
      videoTrack = keepTrack(videoAttempt.stream, "video");
      video = videoTrack ? "ok" : "no-video-track";
    } else {
      video = videoAttempt.name;
    }
    parts.push("android-audio-first=1");
  } else {
    const attempt = async (constraints: MediaStreamConstraints): Promise<string> => {
      const result = await capture(constraints);
      if (result.stream) {
        for (const track of result.stream.getTracks()) track.stop();
      }
      return result.name;
    };

    audio = await attempt({ audio: true });
    video = await attempt({ video: true });

    // Hardware contention is often momentary — a previous holder releasing late. One retry
    // separates "busy right now" from "cannot be opened at all".
    if (audio !== "ok") {
      await new Promise((resolve) => setTimeout(resolve, 800));
      const second = await attempt({ audio: true });
      audio = second === "ok" ? "ok (after retry)" : `${audio}/${second}`;
    }

    // Default audio constraints ask for the hardware echo canceller. When that path is
    // unavailable the request fails even though the microphone itself is free.
    // The track is kept alive rather than stopped, because the publisher will use it.
    if (!audio.startsWith("ok")) {
      const raw = await capture({ audio: rawAudio });
      audioTrack = raw.stream ? keepTrack(raw.stream, "audio") : null;
      parts.push(audioTrack ? "raw-audio=ok" : `raw-audio=${raw.name}`);
    }
  }

  parts.push(`audio=${audio}`, `video=${video}`);
  return { audio, video, report: parts.join(" · "), audioTrack, videoTrack };
}

const playing = new WeakSet<MediaStream>();
let playback: AudioContext | null = null;

/** Plays a remote stream through Web Audio. The tile's media element stays muted on Android. */
function playRemote(stream: MediaStream) {
  if (playing.has(stream) || stream.getAudioTracks().length === 0) return;
  playing.add(stream);
  if (!playback) playback = new AudioContext();
  void playback.resume().catch(() => undefined);
  const source = playback.createMediaStreamSource(stream);
  source.connect(playback.destination);
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
    const subscriber = session.subscribe(
      event.stream,
      tile,
      { insertMode: "append", width: "100%", height: "100%", subscribeToAudio: true, audioVolume: 100 },
      (error) => {
        if (error) removeTile(id);
        // The track only exists once the subscriber is wired up, so paint after it lands.
        else setTimeout(paint, 0);
      },
    );
    // Android WebView leaves the remote tile silent. Play that stream through Web Audio
    // instead, and keep the element muted so the same voice is not heard twice.
    const audible = (element: HTMLMediaElement) => {
      const source = element.srcObject;
      if (isAndroid()) {
        element.muted = true;
        if (source instanceof MediaStream) playRemote(source);
        return;
      }
      element.muted = false;
      element.volume = 1;
      void element.play().catch(() => undefined);
    };
    subscriber.on("videoElementCreated", (created: { element: HTMLVideoElement }) => audible(created.element));
    subscriber.on("audioElementCreated", (created: { element: HTMLAudioElement }) => audible(created.element));
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
  // Give the hardware a moment to be released before Vonage asks for it. Skipped when the
  // probe is handing over live tracks — stopping them here would drop the camera we just opened.
  if (!probe.audioTrack && !probe.videoTrack) {
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

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
          ...(withVideo
            ? probe.videoTrack
              ? { videoSource: probe.videoTrack }
              : {}
            : { videoSource: null }),
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
