// C1 capture target: thumb-zone, ≥96pt tall, single-word label. Instrument
// register — the icon and one word, nothing else.

import { Feather } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text } from "react-native";

import { useTheme } from "../../theme";
import { radii, spacing, typeScale } from "../../theme/tokens";

const ICONS = { text: "type", voice: "mic", photo: "camera" } as const;
const LABELS = { text: "Text", voice: "Voice", photo: "Photo" } as const;

export type CaptureKind = keyof typeof ICONS;

export function CaptureButton({
  kind,
  onPress,
  label,
}: {
  kind: CaptureKind;
  onPress: () => void;
  label?: string;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.target,
        {
          backgroundColor: pressed ? colors.bgSurface2 : colors.bgSurface,
          borderColor: colors.line,
        },
      ]}
    >
      <Feather name={ICONS[kind]} size={22} color={colors.ink1} />
      <Text style={[styles.label, { color: colors.ink2 }]}>{label ?? LABELS[kind]}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  target: {
    flex: 1,
    height: spacing.hitCapture,
    borderRadius: radii.capture,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.s2,
  },
  label: {
    fontSize: typeScale.bodySm,
    fontWeight: "600",
  },
});
