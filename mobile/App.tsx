import {
  SealedCall,
  keepAliveAvailable,
  nativePermissionState,
  useSealedCall,
  type NativePermissionState,
} from "@booth/sealed-call-native";
import Constants from "expo-constants";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

import { fetchOpenRooms, heartbeat, newRoomName, normalizeBase, type OpenRoom } from "./src/lobby";
import { useMediaPermissions } from "./src/permissions";

const extra = (Constants.expoConfig?.extra ?? {}) as { callUrl?: string; room?: string };

type Screen =
  | { kind: "lobby" }
  | { kind: "join"; room: string }
  | { kind: "call"; room: string };

export default function App() {
  return (
    <SafeAreaProvider>
      <Root />
    </SafeAreaProvider>
  );
}

function Root() {
  const [apiBase, setApiBase] = useState(extra.callUrl ?? "");
  const [name, setName] = useState("");
  const [screen, setScreen] = useState<Screen>({ kind: "lobby" });

  // The room this device created. We must not offer to "join" our own room, or the
  // creator would be bounced to a join screen by their own announcement. State rather
  // than a ref because the lobby reads it while rendering.
  const [ownRoom, setOwnRoom] = useState<string | null>(null);

  const create = useCallback(() => {
    const room = newRoomName();
    setOwnRoom(room);
    setScreen({ kind: "call", room });
  }, []);

  if (screen.kind === "lobby") {
    return (
      <Lobby
        apiBase={apiBase}
        name={name}
        onApiBase={setApiBase}
        onName={setName}
        onCreate={create}
        ownRoom={ownRoom}
        onRoomAppeared={(room) => setScreen({ kind: "join", room })}
      />
    );
  }

  if (screen.kind === "join") {
    return (
      <Join
        room={screen.room}
        onJoin={() => setScreen({ kind: "call", room: screen.room })}
        onBack={() => setScreen({ kind: "lobby" })}
      />
    );
  }

  return (
    <Call
      apiBase={normalizeBase(apiBase)}
      room={screen.room}
      name={name.trim() || "Tester"}
      onLeave={() => {
        setOwnRoom(null);
        setScreen({ kind: "lobby" });
      }}
    />
  );
}

/**
 * Whether a URL can get the camera.
 *
 * https always can. Plain http only on loopback, which browsers treat as a secure
 * context — useful on the iOS simulator. An Android emulator reaches the host as
 * 10.0.2.2, which is not loopback, so Android needs https.
 */
function isSecureContextUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "https:") return true;
    if (parsed.protocol !== "http:") return false;
    return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

function Lobby(props: {
  apiBase: string;
  name: string;
  ownRoom: string | null;
  onApiBase(value: string): void;
  onName(value: string): void;
  onCreate(): void;
  onRoomAppeared(room: string): void;
}) {
  // Surfaced on the first screen, not only inside a call: a permission the app believes it
  // has but the OS never granted is the single most misleading failure here.
  const [permissionNote, setPermissionNote] = useState("Checking permissions…");
  useEffect(() => {
    let cancelled = false;
    void nativePermissionState().then((state) => {
      if (cancelled) return;
      setPermissionNote(
        state
          ? `OS permissions: mic=${state.recordAudio} cam=${state.camera} audioMode=${state.audioMode} micMuted=${state.micMuted}`
          : "OS permission check unavailable — native module not linked (expected in Expo Go).",
      );
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const [rooms, setRooms] = useState<OpenRoom[]>([]);
  const [problem, setProblem] = useState("");
  const ready = isSecureContextUrl(normalizeBase(props.apiBase));

  const { ownRoom, onRoomAppeared } = props;
  const base = normalizeBase(props.apiBase);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const controller = new AbortController();

    const tick = async () => {
      try {
        const open = await fetchOpenRooms(base, controller.signal);
        if (cancelled) return;
        setProblem("");
        setRooms(open);
        // The whole point: someone else opened a room, so move straight to the join
        // screen rather than making the user read a list and tap.
        const other = open.find((entry) => entry.room !== ownRoom);
        if (other) onRoomAppeared(other.room);
      } catch (error) {
        if (cancelled || controller.signal.aborted) return;
        setProblem(error instanceof Error ? error.message : String(error));
      }
    };

    void tick();
    const timer = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
    };
  }, [base, ready, ownRoom, onRoomAppeared]);

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.setup}
      >
        <Text style={styles.title}>Set up a room</Text>
        <Text style={styles.subtitle}>
          Create one here, or wait — if someone else opens a room you will be taken to it.
        </Text>

        <Text style={styles.label}>Backend</Text>
        <TextInput
          style={styles.input}
          value={props.apiBase}
          onChangeText={props.onApiBase}
          placeholder="http://localhost:3000"
          placeholderTextColor="#667"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />

        <Text style={styles.label}>Your name</Text>
        <TextInput
          style={styles.input}
          value={props.name}
          onChangeText={props.onName}
          placeholder="Tester"
          placeholderTextColor="#667"
          autoCapitalize="words"
        />

        <Pressable
          style={[styles.primary, !ready && styles.disabled]}
          onPress={() => {
            if (!ready) {
              Alert.alert(
                "Not a secure origin",
                "The backend needs https, or plain http on localhost.",
              );
              return;
            }
            props.onCreate();
          }}
        >
          <Text style={styles.primaryText}>Create a room</Text>
        </Pressable>

        <View style={styles.waiting}>
          {ready ? (
            <>
              <ActivityIndicator color="#3ba776" />
              <Text style={styles.note}>
                {rooms.length === 0
                  ? "Watching for a room…"
                  : `${rooms.length} room${rooms.length === 1 ? "" : "s"} open`}
              </Text>
            </>
          ) : (
            <Text style={styles.note}>Enter the backend URL to start watching.</Text>
          )}
        </View>

        {problem ? <Text style={styles.problem}>{problem}</Text> : null}

        <Text style={styles.note}>
          {permissionNote}
        </Text>

        <Text style={styles.note}>
          {keepAliveAvailable()
            ? "Background keep-alive: linked."
            : "Background keep-alive: not linked — expected in Expo Go. The call drops if you background it."}
        </Text>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Join(props: { room: string; onJoin(): void; onBack(): void }) {
  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />
      <View style={styles.setup}>
        <Text style={styles.title}>A room is open</Text>
        <Text style={styles.subtitle}>Someone started a call. Join to connect.</Text>

        <View style={styles.roomCard}>
          <Text style={styles.roomName}>{props.room}</Text>
        </View>

        <Pressable style={styles.primary} onPress={props.onJoin}>
          <Text style={styles.primaryText}>Join</Text>
        </Pressable>
        <Pressable style={styles.secondary} onPress={props.onBack}>
          <Text style={styles.secondaryText}>Back</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

function Call(props: { apiBase: string; room: string; name: string; onLeave(): void }) {
  const permissions = useMediaPermissions();

  if (permissions.loading) {
    return (
      <SafeAreaView style={styles.screen}>
        <View style={styles.setup}>
          <ActivityIndicator color="#3ba776" />
        </View>
      </SafeAreaView>
    );
  }

  if (!permissions.granted) {
    return (
      <Grant
        blocked={permissions.blocked}
        onAllow={() => void permissions.request()}
        onBack={props.onLeave}
      />
    );
  }

  return <Live {...props} />;
}

function Grant(props: { blocked: boolean; onAllow(): void; onBack(): void }) {
  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />
      <View style={styles.setup}>
        <Text style={styles.title}>Camera and microphone</Text>
        <Text style={styles.subtitle}>
          {props.blocked
            ? "These were denied for this app. Open Settings and allow camera and microphone, then come back."
            : "The call runs inside a web view, and the web view can only reach the camera if this app already holds the permission."}
        </Text>
        {!props.blocked && (
          <Pressable style={styles.primary} onPress={props.onAllow}>
            <Text style={styles.primaryText}>Allow</Text>
          </Pressable>
        )}
        <Pressable style={styles.secondary} onPress={props.onBack}>
          <Text style={styles.secondaryText}>Back</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

function Live(props: { apiBase: string; room: string; name: string; onLeave(): void }) {
  // What the OS says, not what expo-camera says. Device labels appear once *any* capture
  // permission is granted, so audio can look permitted when only the camera was.
  const [osPermissions, setOsPermissions] = useState<NativePermissionState | null>(null);
  useEffect(() => {
    let cancelled = false;
    void nativePermissionState().then((state) => {
      if (!cancelled) setOsPermissions(state);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const call = useSealedCall({
    onUnsupported: (reason) => Alert.alert("Cannot encrypt on this device", reason),
  });
  const [passphrase, setPassphrase] = useState("");
  const [fingerprint, setFingerprint] = useState("");
  const [busy, setBusy] = useState(false);

  const { apiBase, room } = props;

  useEffect(() => {
    // Keeps the room visible in the other device's lobby for as long as we are here.
    const beat = () => void heartbeat(apiBase, room).catch(() => undefined);
    beat();
    const timer = setInterval(beat, 30_000);
    return () => clearInterval(timer);
  }, [apiBase, room]);

  const {
    status,
    hasKey,
    keyId,
    generation,
    lockedStreams,
    securedStreams,
    plaintextStreams,
    tracks,
  } = call.state;

  const seal = async () => {
    if (!passphrase.trim()) return;
    setBusy(true);
    try {
      // Shown so both sides can read it aloud and confirm the same key was derived. The
      // passphrase itself never leaves the two devices.
      setFingerprint(await call.fingerprint(passphrase));
      call.setKey(passphrase);
    } catch (error) {
      Alert.alert("Could not seal", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      <SealedCall
        url={`${apiBase}/surface/index.html`}
        config={{ apiBase, room, name: props.name }}
        call={call}
        
        // Free ngrok shows an interstitial warning page in front of the first HTML
        // request, which a WebView has no way to click through. Harmless elsewhere.
        headers={{ "ngrok-skip-browser-warning": "1" }}
        keepAlive={{ title: "Booth call", body: "Tap to return to the call" }}
        
        onError={(message) => Alert.alert("Call page error", message)}
      />

      <SafeAreaView style={styles.panel} pointerEvents="box-none">
        <ScrollView style={styles.panelScroll} contentContainerStyle={styles.panelInner}>
          <View style={styles.row}>
            <Badge status={status} />
            <Text style={styles.roomTag}>{room}</Text>
            <Pressable style={styles.leave} onPress={props.onLeave}>
              <Text style={styles.leaveText}>Leave</Text>
            </Pressable>
          </View>

          {/* What the WebView and the page are doing. Shown natively, because a page
              that is not painting cannot tell you anything itself. */}
          <Text style={styles.stat}>
            page {call.page.loaded ? "loaded" : "loading…"}
            {call.page.httpStatus ? ` · http ${call.page.httpStatus}` : ""}
            {call.page.status ? ` · ${call.page.status}` : ""}
          </Text>
          {call.page.media ? <Text style={styles.stat}>{call.page.media}</Text> : null}
          {osPermissions ? (
            <Text style={styles.stat}>
              os: mic={String(osPermissions.recordAudio)} cam={String(osPermissions.camera)} mode=
              {osPermissions.audioMode} muted={String(osPermissions.micMuted)}
            </Text>
          ) : null}
          {call.page.error ? <Text style={styles.problem}>{call.page.error}</Text> : null}

          <Text style={styles.stat}>
            sealed {securedStreams} · locked {lockedStreams} · clear {plaintextStreams}
            {keyId ? ` · key ${keyId}` : ""}
            {generation ? ` · gen ${generation}` : ""}
          </Text>

          {tracks.length > 0 && (
            <View style={styles.tracks}>
              {tracks.map((track) => (
                <Text key={track.trackId} style={styles.track}>
                  {track.kind} · {track.state} · {track.trackId.slice(0, 8)}
                </Text>
              ))}
            </View>
          )}

          {hasKey ? (
            <>
              {fingerprint ? (
                <Text style={styles.fingerprint}>fingerprint {fingerprint}</Text>
              ) : null}
              <Pressable
                style={styles.secondary}
                onPress={() => {
                  call.forgetKey();
                  setFingerprint("");
                  setPassphrase("");
                }}
              >
                <Text style={styles.secondaryText}>Forget key — stop sealing</Text>
              </Pressable>
            </>
          ) : (
            <View style={styles.row}>
              <TextInput
                style={[styles.input, styles.inputInline]}
                value={passphrase}
                onChangeText={setPassphrase}
                placeholder={status === "locked" ? "Unlock this call" : "Passphrase"}
                placeholderTextColor="#667"
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
              />
              <Pressable style={styles.primarySmall} onPress={seal} disabled={busy}>
                {busy ? (
                  <ActivityIndicator color="#04130b" />
                ) : (
                  <Text style={styles.primaryText}>Seal</Text>
                )}
              </Pressable>
            </View>
          )}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const TONE: Record<string, { label: string; color: string }> = {
  connecting: { label: "Connecting", color: "#7c8694" },
  unsupported: { label: "Cannot encrypt", color: "#d2544a" },
  clear: { label: "In the clear", color: "#d99a2b" },
  locked: { label: "Locked", color: "#d2544a" },
  sealed: { label: "Sealed", color: "#3ba776" },
};

function Badge({ status }: { status: string }) {
  const tone = TONE[status] ?? TONE.connecting!;
  return (
    <View style={[styles.badge, { backgroundColor: tone.color }]}>
      <Text style={styles.badgeText}>{tone.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#0b0f0d" },
  setup: { flex: 1, padding: 24, justifyContent: "center", gap: 8 },
  title: { color: "#f2f6f3", fontSize: 26, fontWeight: "700" },
  subtitle: { color: "#8d9a92", fontSize: 14, marginBottom: 16, lineHeight: 20 },
  label: { color: "#8d9a92", fontSize: 12, textTransform: "uppercase", marginTop: 12 },
  input: {
    backgroundColor: "#151b18",
    borderColor: "#27312c",
    borderWidth: 1,
    borderRadius: 10,
    color: "#f2f6f3",
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
  },
  inputInline: { flex: 1 },
  primary: {
    backgroundColor: "#3ba776",
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 24,
  },
  disabled: { opacity: 0.5 },
  primarySmall: {
    backgroundColor: "#3ba776",
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryText: { color: "#04130b", fontWeight: "700", fontSize: 15 },
  secondary: {
    borderColor: "#3a4641",
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
    marginTop: 10,
  },
  secondaryText: { color: "#c8d3cd", fontWeight: "600", fontSize: 14 },
  note: { color: "#6f7b74", fontSize: 12, lineHeight: 18 },
  problem: { color: "#d2544a", fontSize: 12, lineHeight: 18, marginTop: 8 },
  waiting: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 20 },
  roomCard: {
    backgroundColor: "#151b18",
    borderColor: "#27312c",
    borderWidth: 1,
    borderRadius: 12,
    padding: 20,
    alignItems: "center",
    marginTop: 12,
  },
  roomName: { color: "#3ba776", fontSize: 22, fontWeight: "700", letterSpacing: 0.5 },
  roomTag: { color: "#6f7b74", fontSize: 11 },
  panel: { position: "absolute", left: 0, right: 0, bottom: 0 },
  panelScroll: { maxHeight: 320 },
  panelInner: {
    padding: 16,
    gap: 12,
    backgroundColor: "rgba(11,15,13,0.94)",
    borderTopColor: "#27312c",
    borderTopWidth: 1,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  badge: { borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  badgeText: { color: "#04130b", fontWeight: "700", fontSize: 12 },
  leave: {
    marginLeft: "auto",
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderColor: "#3a4641",
    borderWidth: 1,
  },
  leaveText: { color: "#c8d3cd", fontWeight: "600", fontSize: 12 },
  stat: { color: "#8d9a92", fontSize: 12, fontVariant: ["tabular-nums"] },
  tracks: { gap: 2 },
  track: { color: "#6f7b74", fontSize: 11, fontVariant: ["tabular-nums"] },
  fingerprint: { color: "#3ba776", fontSize: 12, fontVariant: ["tabular-nums"] },
});
