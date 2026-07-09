// The three-mode navigation: Read · Capture (center, home) · Act.
// Read carries the amber badge (new `became`), Act the red one (pending).

import { Feather } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { useTheme } from "../../theme";
import { fonts, labelTracking, radii, spacing, typeScale } from "../../theme/tokens";

export type ModeName = "read" | "capture" | "act";

const MODES: { name: ModeName; label: string; icon: "inbox" | "plus" | "zap" }[] = [
  { name: "read", label: "Read", icon: "inbox" },
  { name: "capture", label: "Capture", icon: "plus" },
  { name: "act", label: "Act", icon: "zap" },
];

function Badge({ count, color, textColor }: { count: number; color: string; textColor: string }) {
  if (count <= 0) return null;
  return (
    <View style={[styles.badge, { backgroundColor: color }]}>
      <Text style={[styles.badgeText, { color: textColor }]}>{count > 9 ? "9+" : String(count)}</Text>
    </View>
  );
}

export function ModeBar({
  active,
  onChange,
  readBadge = 0,
  actBadge = 0,
}: {
  active: ModeName;
  onChange: (mode: ModeName) => void;
  readBadge?: number;
  actBadge?: number;
}) {
  const { colors } = useTheme();
  return (
    <View style={[styles.bar, { backgroundColor: colors.bgSurface, borderTopColor: colors.line }]}>
      {MODES.map((mode) => {
        const isActive = mode.name === active;
        const isCenter = mode.name === "capture";
        const tint = isActive ? colors.accent : colors.ink3;
        return (
          <Pressable
            key={mode.name}
            accessibilityRole="button"
            accessibilityState={{ selected: isActive }}
            onPress={() => onChange(mode.name)}
            style={styles.target}
          >
            <View
              style={[
                styles.iconWrap,
                isCenter && styles.centerWrap,
                isCenter && {
                  backgroundColor: isActive ? colors.accent : colors.bgSurface2,
                  borderColor: isActive ? colors.accent : colors.lineStrong,
                },
              ]}
            >
              <Feather
                name={mode.icon}
                size={isCenter ? 24 : 20}
                color={isCenter ? (isActive ? colors.inkInverse : colors.ink2) : tint}
              />
              {mode.name === "read" && (
                <Badge count={readBadge} color={colors.accent} textColor={colors.inkInverse} />
              )}
              {mode.name === "act" && (
                <Badge count={actBadge} color={colors.stateNeedsHuman} textColor="#FFFFFF" />
              )}
            </View>
            <Text style={[styles.label, { color: tint }]}>{mode.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: spacing.s2,
    paddingBottom: spacing.thumbBottom - spacing.s2,
  },
  target: {
    flex: 1,
    minHeight: spacing.hitMin,
    alignItems: "center",
    gap: 3,
  },
  iconWrap: {
    alignItems: "center",
    justifyContent: "center",
  },
  centerWrap: {
    width: 52,
    height: 52,
    marginTop: -spacing.s5,
    borderRadius: 26,
    borderWidth: 1,
  },
  label: {
    fontFamily: fonts.mono,
    fontSize: typeScale.label - 1,
    letterSpacing: labelTracking,
    textTransform: "uppercase",
  },
  badge: {
    position: "absolute",
    top: -4,
    right: -10,
    minWidth: 16,
    height: 16,
    borderRadius: radii.chip,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
  },
  badgeText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    fontWeight: "700",
  },
});
