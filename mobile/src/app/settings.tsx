import { useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { getApi, settings } from "../lib/brain";

export default function SettingsScreen() {
  const [url, setUrl] = useState("");
  const [health, setHealth] = useState("checking…");

  const checkHealth = useCallback(async () => {
    try {
      const api = await getApi();
      const res = await api.health();
      setHealth(`ok — ${res.brainRoot}`);
    } catch {
      setHealth("unreachable");
    }
  }, []);

  useEffect(() => {
    void settings.getBaseUrl().then(setUrl);
    // On-mount server probe; every setState inside happens after an await,
    // so no synchronous cascading render is possible.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void checkHealth();
  }, [checkHealth]);

  async function save() {
    setHealth("checking…");
    await settings.setBaseUrl(url);
    await checkHealth();
  }

  return (
    <View style={styles.container}>
      <Text style={styles.label}>Brain-host URL</Text>
      <TextInput
        style={styles.input}
        value={url}
        onChangeText={setUrl}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
      />
      <Pressable style={styles.button} onPress={save}>
        <Text style={styles.buttonLabel}>Save</Text>
      </Pressable>
      <Text style={styles.health}>{health}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 16,
    gap: 12,
  },
  label: {
    fontWeight: "600",
  },
  input: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    padding: 12,
    fontSize: 15,
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
  },
  health: {
    textAlign: "center",
  },
});
