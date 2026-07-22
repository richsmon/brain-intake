// BI-C6: dictation affordance for prompt inputs (New Session, follow-up).
// Record → upload to POST /sessions/transcribe → transcript lands in the
// caller's text field for editing. Deliberately NOT the capture voice flow:
// capture is fire-and-forget into the inbox with host-side async STT; this
// needs the text back in-hand, so it talks to the synchronous endpoint.
// Errors go to the caller and the input stays untouched — dictation being
// unavailable (WHISPER_CMD unset on the host) must never cost typed text.

import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { RecordingPresets, requestRecordingPermissionsAsync, useAudioRecorder } from "expo-audio";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import { ApiError } from "../../lib/api";
import { getSessionsApi } from "../../lib/brain";
import { type DictationExt } from "../../lib/sessions";
import { useTheme } from "../../theme";
import { fonts, radii, spacing, typeScale } from "../../theme/tokens";

function formatElapsed(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function extOf(uri: string): DictationExt {
  const ext = uri.split(".").pop()?.toLowerCase();
  return ext === "mp3" || ext === "wav" ? ext : "m4a";
}

type Phase = "idle" | "recording" | "transcribing";

export function DictationButton({
  onTranscript,
  onDictationError,
}: {
  onTranscript: (text: string) => void;
  /** Clear failure message; the caller shows it. The text input is never touched. */
  onDictationError: (message: string) => void;
}) {
  const { colors } = useTheme();
  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);

  useEffect(() => {
    if (phase !== "recording") return;
    const timer = setInterval(() => {
      const seconds = Math.floor(recorder.currentTime);
      setElapsed(Number.isFinite(seconds) ? seconds : 0);
    }, 500);
    return () => clearInterval(timer);
  }, [phase, recorder]);

  async function start() {
    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) {
      onDictationError("Microphone permission denied");
      return;
    }
    await recorder.prepareToRecordAsync();
    recorder.record();
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {}); // record-start
    setElapsed(0);
    setPhase("recording");
  }

  async function stop() {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {}); // record-stop
    await recorder.stop();
    const uri = recorder.uri;
    if (!uri) {
      setPhase("idle");
      onDictationError("That recording failed. Try again.");
      return;
    }
    setPhase("transcribing");
    try {
      const api = await getSessionsApi();
      if (!api) throw new ApiError("unreachable");
      const ext = extOf(uri);
      const { text } = await api.transcribe({ uri, name: `dictation.${ext}`, ext });
      if (text.trim()) onTranscript(text.trim());
      else onDictationError("Nothing heard — try again closer to the mic.");
    } catch (err) {
      onDictationError(
        err instanceof ApiError && err.status === 503
          ? "Dictation isn't set up on the mini — type it instead."
          : "Dictation didn't reach the mini — type it instead.",
      );
    } finally {
      setPhase("idle");
    }
  }

  if (phase === "transcribing") {
    return (
      <View style={[styles.control, { borderColor: colors.line, backgroundColor: colors.bgSurface }]}>
        <ActivityIndicator size="small" color={colors.accent} />
        <Text style={[styles.label, { color: colors.ink3 }]}>Transcribing…</Text>
      </View>
    );
  }

  if (phase === "recording") {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Stop dictation"
        onPress={() => void stop()}
        style={[styles.control, { borderColor: colors.recording, backgroundColor: colors.stateNeedsHumanSoft }]}
      >
        <View style={[styles.dot, { backgroundColor: colors.recording }]} />
        <Text style={[styles.elapsed, { color: colors.ink1 }]}>{formatElapsed(elapsed)}</Text>
        <Text style={[styles.label, { color: colors.recording }]}>Stop</Text>
      </Pressable>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Dictate"
      onPress={() => void start()}
      style={({ pressed }) => [
        styles.control,
        { borderColor: colors.line, backgroundColor: pressed ? colors.bgSurface2 : colors.bgSurface },
      ]}
    >
      <Feather name="mic" size={16} color={colors.ink2} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  control: {
    minHeight: 36,
    minWidth: 44,
    borderWidth: 1,
    borderRadius: radii.control,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.s2,
    paddingHorizontal: spacing.s3,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  elapsed: {
    fontFamily: fonts.mono,
    fontSize: typeScale.bodySm,
    fontVariant: ["tabular-nums"],
  },
  label: {
    fontSize: typeScale.bodySm,
    fontWeight: "600",
  },
});
