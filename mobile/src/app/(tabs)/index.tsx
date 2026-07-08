import { RecordingPresets, requestRecordingPermissionsAsync, useAudioRecorder } from "expo-audio";
import * as ImagePicker from "expo-image-picker";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { captureFile, captureText } from "../../lib/brain";

export default function CaptureScreen() {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);

  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => {
      const seconds = Math.floor(recorder.currentTime);
      setElapsed(Number.isFinite(seconds) ? seconds : 0);
    }, 500);
    return () => clearInterval(timer);
  }, [recording, recorder]);

  async function saveText() {
    const trimmed = text.trim();
    if (!trimmed) return;
    await captureText(trimmed);
    setText("");
    setStatus("Queued ✓");
  }

  async function pickPhoto(from: "camera" | "library") {
    if (from === "camera") {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        setStatus("Camera permission denied");
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
    setStatus(outcome.ok ? "Queued ✓" : outcome.reason);
  }

  async function toggleRecording() {
    if (recording) {
      await recorder.stop();
      setRecording(false);
      const uri = recorder.uri;
      if (!uri) {
        setStatus("Recording failed");
        return;
      }
      const outcome = await captureFile({ source: "voice", uri });
      setStatus(outcome.ok ? "Queued ✓" : outcome.reason);
    } else {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        setStatus("Microphone permission denied");
        return;
      }
      await recorder.prepareToRecordAsync();
      recorder.record();
      setElapsed(0);
      setStatus(null);
      setRecording(true);
    }
  }

  return (
    <View style={styles.container}>
      <TextInput
        style={styles.input}
        placeholder="Text note…"
        value={text}
        onChangeText={(value) => {
          setText(value);
          setStatus(null);
        }}
        multiline
      />
      <Pressable style={styles.button} onPress={saveText}>
        <Text style={styles.buttonLabel}>Save to brain</Text>
      </Pressable>
      <View style={styles.row}>
        <Pressable style={styles.secondaryButton} onPress={() => pickPhoto("camera")}>
          <Text style={styles.secondaryLabel}>📷 Camera</Text>
        </Pressable>
        <Pressable style={styles.secondaryButton} onPress={() => pickPhoto("library")}>
          <Text style={styles.secondaryLabel}>🖼 Library</Text>
        </Pressable>
        <Pressable
          style={[styles.secondaryButton, recording && styles.recordingButton]}
          onPress={toggleRecording}
        >
          <Text style={styles.secondaryLabel}>
            {recording ? `⏹ Stop (${elapsed}s)` : "🎤 Record"}
          </Text>
        </Pressable>
      </View>
      {status ? <Text style={styles.status}>{status}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 16,
    gap: 12,
  },
  input: {
    minHeight: 120,
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    padding: 12,
    textAlignVertical: "top",
    fontSize: 16,
  },
  button: {
    backgroundColor: "#208AEF",
    borderRadius: 8,
    padding: 14,
    alignItems: "center",
  },
  buttonLabel: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 16,
  },
  row: {
    flexDirection: "row",
    gap: 8,
  },
  secondaryButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#208AEF",
    borderRadius: 8,
    padding: 12,
    alignItems: "center",
  },
  recordingButton: {
    backgroundColor: "#fdecea",
    borderColor: "#c62828",
  },
  secondaryLabel: {
    fontSize: 13,
    fontWeight: "600",
  },
  status: {
    textAlign: "center",
    color: "#2e7d32",
  },
});
