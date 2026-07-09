// R1 stream row: payload preview + state chip + age. The list answers "what
// happened to my thoughts" without opening anything.

import { Pressable, StyleSheet, Text, View } from "react-native";

import { useTheme } from "../../theme";
import { fonts, spacing, typeScale } from "../../theme/tokens";
import { EventStateChip } from "./event-state-chip";

export function ItemRow({
  title,
  state,
  stateLabel,
  age,
  source,
  onPress,
}: {
  title: string;
  state: string;
  stateLabel?: string;
  age?: string;
  source?: string;
  onPress?: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        { borderBottomColor: colors.line },
        pressed && { backgroundColor: colors.bgSurface2 },
      ]}
    >
      <Text numberOfLines={1} style={[styles.title, { color: colors.ink1 }]}>
        {title}
      </Text>
      <View style={styles.meta}>
        <EventStateChip state={state} label={stateLabel} />
        {source ? <Text style={[styles.mono, { color: colors.ink3 }]}>{source}</Text> : null}
        <View style={styles.spacer} />
        {age ? <Text style={[styles.mono, { color: colors.ink3 }]}>{age}</Text> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    paddingHorizontal: spacing.s4,
    paddingVertical: spacing.s3,
    gap: spacing.s2,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: {
    fontSize: typeScale.body,
    fontWeight: "600",
    lineHeight: typeScale.body * 1.3,
  },
  meta: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.s2,
  },
  spacer: {
    flex: 1,
  },
  mono: {
    fontFamily: fonts.mono,
    fontSize: typeScale.label,
  },
});
