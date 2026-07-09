// S1 Settings — minimal, boring, fine: the brain-host URL, a health probe, and
// the theme preference. The tailnet is the security boundary.

import { useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { getApi, settings } from "../lib/brain";
import { useTheme, type ThemePreference } from "../theme";
import { fonts, labelTracking, radii, spacing, typeScale } from "../theme/tokens";

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

export default function SettingsScreen() {
  const { colors, preference, setPreference } = useTheme();
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
      <Text style={[styles.label, { color: colors.ink3 }]}>Brain-host URL</Text>
      <TextInput
        style={[
          styles.input,
          { borderColor: colors.line, backgroundColor: colors.bgSurface2, color: colors.ink1 },
        ]}
        value={url}
        onChangeText={setUrl}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
      />
      <Pressable
        accessibilityRole="button"
        onPress={save}
        style={({ pressed }) => [
          styles.save,
          { backgroundColor: pressed ? colors.accentStrong : colors.accent },
        ]}
      >
        <Text style={[styles.saveLabel, { color: colors.inkInverse }]}>Save</Text>
      </Pressable>
      <Text style={[styles.health, { color: colors.ink2 }]}>{health}</Text>
      <Text style={[styles.caption, { color: colors.ink3 }]}>
        The tailnet is the security boundary. I never leave it.
      </Text>

      <Text style={[styles.label, styles.section, { color: colors.ink3 }]}>Theme</Text>
      <View style={styles.segments}>
        {THEME_OPTIONS.map((option) => {
          const active = option.value === preference;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              onPress={() => setPreference(option.value)}
              style={[
                styles.segment,
                {
                  borderColor: active ? colors.accent : colors.line,
                  backgroundColor: active ? colors.accentSoft : colors.bgSurface,
                },
              ]}
            >
              <Text style={[styles.segmentLabel, { color: active ? colors.accent : colors.ink2 }]}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: spacing.s4,
    gap: spacing.s3,
  },
  label: {
    fontFamily: fonts.mono,
    fontSize: typeScale.label,
    letterSpacing: labelTracking,
    textTransform: "uppercase",
    fontWeight: "600",
  },
  section: {
    marginTop: spacing.s4,
  },
  input: {
    borderWidth: 1,
    borderRadius: radii.control,
    padding: spacing.s3,
    fontFamily: fonts.mono,
    fontSize: typeScale.bodySm,
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
  health: {
    fontFamily: fonts.mono,
    fontSize: typeScale.caption,
    textAlign: "center",
  },
  caption: {
    fontSize: typeScale.caption,
    textAlign: "center",
  },
  segments: {
    flexDirection: "row",
    gap: spacing.s2,
  },
  segment: {
    flex: 1,
    minHeight: spacing.hitMin,
    borderWidth: 1,
    borderRadius: radii.control,
    alignItems: "center",
    justifyContent: "center",
  },
  segmentLabel: {
    fontSize: typeScale.bodySm,
    fontWeight: "600",
  },
});
