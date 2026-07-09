// Offline is a normal state, never red. Quiet stone pill with the queued count;
// silent when nothing waits.

import { StyleSheet, Text, View } from "react-native";

import { useTheme } from "../../theme";
import { fonts, radii, typeScale } from "../../theme/tokens";

export function OfflineBadge({ queued }: { queued: number }) {
  const { colors } = useTheme();
  if (queued <= 0) return null;
  return (
    <View style={[styles.badge, { backgroundColor: colors.stateQueuedSoft }]}>
      <Text style={[styles.label, { color: colors.offline }]}>{`⌵ ${queued} queued`}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    borderRadius: radii.chip,
    paddingHorizontal: 9,
    paddingVertical: 3,
    alignSelf: "flex-start",
  },
  label: {
    fontFamily: fonts.mono,
    fontSize: typeScale.label,
    letterSpacing: 0.3,
  },
});
