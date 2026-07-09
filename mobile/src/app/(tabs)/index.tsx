// C1 Quick Capture — the app's home. Thumb-zone layout, three ≥96pt targets,
// no-look voice, offline as a normal state. Instrument register: single-word
// labels, confirmation is a state chip, never a sentence.

import { Feather } from "@expo/vector-icons";
import { RecordingPresets, requestRecordingPermissionsAsync, useAudioRecorder } from "expo-audio";
import * as ImagePicker from "expo-image-picker";
import { Link } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { CaptureButton } from "../../components/ds/capture-button";
import { EventStateChip } from "../../components/ds/event-state-chip";
import { OfflineBadge } from "../../components/ds/offline-badge";
import { RecordingIndicator } from "../../components/ds/recording-indicator";
import { ScreenHeader } from "../../components/ds/screen-header";
import { captureFile, captureText, pendingEntries } from "../../lib/brain";
import { useTheme } from "../../theme";
import { radii, spacing, typeScale } from "../../theme/tokens";

function formatElapsed(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export default function CaptureScreen() {
  const { colors } = useTheme();
  const [text, setText] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [queued, setQueued] = useState(0);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<TextInput>(null);
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);

  const refreshQueued = useCallback(() => {
    pendingEntries()
      .then((entries) => setQueued(entries.length))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshQueued();
    return () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    };
  }, [refreshQueued]);

  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => {
      const seconds = Math.floor(recorder.currentTime);
      setElapsed(Number.isFinite(seconds) ? seconds : 0);
    }, 500);
    return () => clearInterval(timer);
  }, [recording, recorder]);

  function confirmQueued() {
    setError(null);
    setConfirmed(true);
    refreshQueued();
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    confirmTimer.current = setTimeout(() => setConfirmed(false), 1800);
  }

  async function saveText() {
    const trimmed = text.trim();
    if (!trimmed) return;
    Keyboard.dismiss();
    await captureText(trimmed);
    setText("");
    confirmQueued();
  }

  async function capturePhotoFrom(from: "camera" | "library") {
    if (from === "camera") {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        setError("Camera permission denied");
        return;
      }
    }
    const result =
      from === "camera"
        ? await ImagePicker.launchCameraAsync()
        : await ImagePicker.launchImageLibraryAsync();
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    const outcome = await captureFile({
      source: "photo",
      uri: asset.uri,
      name: asset.fileName ?? undefined,
      sizeBytes: asset.fileSize ?? undefined,
    });
    if (outcome.ok) confirmQueued();
    else setError(outcome.reason);
  }

  function pickPhoto() {
    Keyboard.dismiss();
    Alert.alert("Photo", undefined, [
      { text: "Camera", onPress: () => void capturePhotoFrom("camera") },
      { text: "Library", onPress: () => void capturePhotoFrom("library") },
      { text: "Cancel", style: "cancel" },
    ]);
  }

  async function toggleRecording() {
    if (recording) {
      await recorder.stop();
      setRecording(false);
      const uri = recorder.uri;
      if (!uri) {
        setError("That recording failed. Try again.");
        return;
      }
      const outcome = await captureFile({ source: "voice", uri });
      if (outcome.ok) confirmQueued();
      else setError(outcome.reason);
    } else {
      Keyboard.dismiss();
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        setError("Microphone permission denied");
        return;
      }
      await recorder.prepareToRecordAsync();
      recorder.record();
      setElapsed(0);
      setError(null);
      setRecording(true);
    }
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.bgCanvas }]}>
      <ScreenHeader
        title="Brainer"
        right={
          <Link href="/settings" asChild>
            <Pressable accessibilityRole="button" accessibilityLabel="Settings" style={styles.gear}>
              <Feather name="settings" size={18} color={colors.ink3} />
            </Pressable>
          </Link>
        }
      >
        <OfflineBadge queued={queued} />
      </ScreenHeader>

      <KeyboardAvoidingView
        style={styles.avoid}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={0}
      >
        {/* Empty space above the thumb zone: tap anywhere to put the keyboard away. */}
        <Pressable
          accessibilityLabel="Dismiss keyboard"
          style={styles.dismissZone}
          onPress={() => Keyboard.dismiss()}
        />
        <View style={styles.thumbZone}>
        {confirmed && !recording ? (
          <View style={styles.confirm}>
            <EventStateChip state="queued" />
          </View>
        ) : null}
        {error ? <Text style={[styles.error, { color: colors.danger }]}>{error}</Text> : null}

        <TextInput
          ref={inputRef}
          style={[
            styles.input,
            {
              borderColor: colors.line,
              backgroundColor: colors.bgSurface2,
              color: colors.ink1,
            },
          ]}
          placeholder="Text note…"
          placeholderTextColor={colors.ink3}
          value={text}
          onChangeText={(value) => {
            setText(value);
            setError(null);
          }}
          multiline
        />

        {text.trim() ? (
          <Pressable
            accessibilityRole="button"
            onPress={saveText}
            style={({ pressed }) => [
              styles.save,
              { backgroundColor: pressed ? colors.accentStrong : colors.accent },
            ]}
          >
            <Text style={[styles.saveLabel, { color: colors.inkInverse }]}>Save to brain</Text>
          </Pressable>
        ) : null}

        {recording ? (
          <RecordingIndicator elapsed={formatElapsed(elapsed)} onStop={toggleRecording} />
        ) : (
          <View style={styles.targets}>
            <CaptureButton kind="text" onPress={() => inputRef.current?.focus()} />
            <CaptureButton kind="voice" onPress={toggleRecording} />
            <CaptureButton kind="photo" onPress={pickPhoto} />
          </View>
        )}
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  gear: {
    minWidth: spacing.hitMin,
    minHeight: spacing.hitMin,
    alignItems: "center",
    justifyContent: "center",
  },
  avoid: {
    flex: 1,
  },
  dismissZone: {
    flex: 1,
  },
  thumbZone: {
    justifyContent: "flex-end",
    paddingHorizontal: spacing.s4,
    paddingBottom: spacing.s4,
    gap: spacing.s3,
  },
  confirm: {
    alignItems: "center",
  },
  error: {
    fontSize: typeScale.bodySm,
    textAlign: "center",
  },
  input: {
    minHeight: 88,
    borderWidth: 1,
    borderRadius: radii.control,
    padding: spacing.s3 + 2,
    textAlignVertical: "top",
    fontSize: 16,
    lineHeight: 22,
  },
  save: {
    minHeight: spacing.hitMin,
    borderRadius: radii.control,
    alignItems: "center",
    justifyContent: "center",
  },
  saveLabel: {
    fontSize: typeScale.body,
    fontWeight: "600",
  },
  targets: {
    flexDirection: "row",
    gap: spacing.s3 - 2,
  },
});
