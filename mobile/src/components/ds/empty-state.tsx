// Empty states speak in the companion voice — first person, concrete, never cute.

import { StyleSheet, Text, View } from "react-native";

import { useTheme } from "../../theme";
import { spacing, typeScale } from "../../theme/tokens";

export function EmptyState({ text }: { text: string }) {
  const { colors } = useTheme();
  return (
    <View style={styles.wrap}>
      <Text style={[styles.text, { color: colors.ink2 }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: "center",
    paddingVertical: spacing.s10,
    paddingHorizontal: spacing.s6,
  },
  text: {
    fontSize: typeScale.body,
    lineHeight: typeScale.body * 1.45,
    textAlign: "center",
    maxWidth: 280,
  },
});
