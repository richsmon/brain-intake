// BI-C2: unified-diff rendering for Edit gate cards — mono lines, +/- coloring
// from the palette (green = added, red = removed), no diff library.

import { StyleSheet, Text, View } from "react-native";

import type { DiffLine } from "../../lib/diff";
import { useTheme } from "../../theme";
import { fonts, radii, spacing, typeScale } from "../../theme/tokens";

export function DiffView({ lines }: { lines: DiffLine[] }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.block, { backgroundColor: colors.bgCanvas, borderColor: colors.line }]}>
      {lines.map((line, i) => {
        const color =
          line.kind === "add" ? colors.success : line.kind === "del" ? colors.danger : colors.ink3;
        const bg =
          line.kind === "add"
            ? colors.stateBecameSoft
            : line.kind === "del"
              ? colors.stateNeedsHumanSoft
              : "transparent";
        const sign = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
        return (
          <View key={i} style={[styles.line, { backgroundColor: bg }]}>
            <Text style={[styles.sign, { color }]}>{sign}</Text>
            <Text style={[styles.text, { color: line.kind === "ctx" ? colors.ink3 : colors.ink1 }]}>
              {line.text || " "}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    borderWidth: 1,
    borderRadius: radii.control,
    paddingVertical: spacing.s1,
    overflow: "hidden",
  },
  line: {
    flexDirection: "row",
    paddingHorizontal: spacing.s2,
  },
  sign: {
    fontFamily: fonts.mono,
    fontSize: typeScale.caption,
    lineHeight: typeScale.caption * 1.5,
    width: 12,
  },
  text: {
    flex: 1,
    fontFamily: fonts.mono,
    fontSize: typeScale.caption,
    lineHeight: typeScale.caption * 1.5,
  },
});
