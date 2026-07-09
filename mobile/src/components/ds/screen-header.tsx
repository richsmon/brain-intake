// Screen title row with slots for badges (children) and a trailing action.

import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";

import { useTheme } from "../../theme";
import { spacing, typeScale } from "../../theme/tokens";

export function ScreenHeader({
  title,
  right,
  children,
}: {
  title: string;
  right?: ReactNode;
  children?: ReactNode;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.row}>
      <Text style={[styles.title, { color: colors.ink1 }]}>{title}</Text>
      {children}
      <View style={styles.spacer} />
      {right}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.s3,
    paddingHorizontal: spacing.s4,
    paddingTop: spacing.s4,
    paddingBottom: spacing.s2,
  },
  title: {
    fontSize: typeScale.heading,
    fontWeight: "600",
    letterSpacing: -0.2,
  },
  spacer: {
    flex: 1,
  },
});
