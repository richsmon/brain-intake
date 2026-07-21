// BI-C2: coding-session states as form + color (mono glyph, colorblind-safe),
// same treatment as the item EventStateChip. Red stays reserved for the states
// that need the founder (waiting-approval) or went wrong (error).

import { StyleSheet, Text, View } from "react-native";

import type { SessionState } from "../../lib/sessions";
import { useTheme } from "../../theme";
import { fonts, radii, typeScale, type Palette } from "../../theme/tokens";

const SESSION_STATES: Record<
  SessionState,
  { glyph: string; label: string; colorKey: keyof Palette; softKey: keyof Palette }
> = {
  created: { glyph: "○", label: "created", colorKey: "stateQueued", softKey: "stateQueuedSoft" },
  running: { glyph: "▸", label: "running", colorKey: "stateClassified", softKey: "stateClassifiedSoft" },
  "waiting-approval": { glyph: "●", label: "waiting", colorKey: "stateNeedsHuman", softKey: "stateNeedsHumanSoft" },
  paused: { glyph: "‖", label: "paused", colorKey: "stateRouted", softKey: "stateRoutedSoft" },
  done: { glyph: "✦", label: "done", colorKey: "stateBecame", softKey: "stateBecameSoft" },
  error: { glyph: "✕", label: "error", colorKey: "stateNeedsHuman", softKey: "stateNeedsHumanSoft" },
};

export function sessionStateVisual(state: string) {
  return SESSION_STATES[state as SessionState] ?? SESSION_STATES.created;
}

export function SessionStateChip({ state }: { state: string }) {
  const { colors } = useTheme();
  const visual = sessionStateVisual(state);
  const color = colors[visual.colorKey];
  return (
    <View style={[styles.chip, { backgroundColor: colors[visual.softKey] }]}>
      <Text style={[styles.glyph, { color }]}>{visual.glyph}</Text>
      <Text style={[styles.label, { color }]}>{visual.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 5,
    borderRadius: radii.chip,
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  glyph: {
    fontFamily: fonts.mono,
    fontSize: typeScale.label,
  },
  label: {
    fontFamily: fonts.mono,
    fontSize: typeScale.label,
    letterSpacing: 0.3,
  },
});
