import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { captureText } from "../../lib/brain";

export default function CaptureScreen() {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  async function save() {
    const trimmed = text.trim();
    if (!trimmed) return;
    await captureText(trimmed);
    setText("");
    setStatus("Queued ✓");
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
      <Pressable style={styles.button} onPress={save}>
        <Text style={styles.buttonLabel}>Save to brain</Text>
      </Pressable>
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
  status: {
    textAlign: "center",
    color: "#2e7d32",
  },
});
