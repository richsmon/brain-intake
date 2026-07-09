// State as form + color: every event state has a mono glyph AND a color, so it
// reads at a glance and colorblind (DS: guidelines/colors-states).

import { StyleSheet, Text, View } from "react-native";

import { useTheme } from "../../theme";
import { eventStateVisual, fonts, radii, typeScale } from "../../theme/tokens";

export function EventStateChip({ state, bare = false }: { state: string; bare?: boolean }) {
  const { colors } = useTheme();
  const visual = eventStateVisual(state);
  const color = colors[visual.colorKey];
  return (
    <View style={[styles.chip, !bare && { backgroundColor: colors[visual.softKey] }]}>
      <Text style={[styles.glyph, { color }]}>{visual.glyph}</Text>
      <Text style={[styles.label, { color }]}>{state}</Text>
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
