// Recording state, built for no-look use: the whole bar is the stop target and
// the pulse is sized to read in peripheral vision (the DS's one deliberate loop).

import { useEffect, useState } from "react";
import { Animated, Pressable, StyleSheet, Text } from "react-native";

import { useTheme } from "../../theme";
import { fonts, motion, radii, spacing, typeScale } from "../../theme/tokens";

export function RecordingIndicator({ elapsed, onStop }: { elapsed: string; onStop: () => void }) {
  const { colors } = useTheme();
  const [pulse] = useState(() => new Animated.Value(1));

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.25, duration: motion.recordPulse / 2, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: motion.recordPulse / 2, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onStop}
      style={[styles.bar, { borderColor: colors.recording, backgroundColor: colors.stateNeedsHumanSoft }]}
    >
      <Animated.View style={[styles.dot, { backgroundColor: colors.recording, opacity: pulse }]} />
      <Text style={[styles.elapsed, { color: colors.ink1 }]}>{elapsed}</Text>
      <Text style={[styles.stop, { color: colors.recording }]}>Stop</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    height: spacing.hitCapture,
    borderRadius: radii.capture,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.s3,
  },
  dot: {
    width: 14,
    height: 14,
    borderRadius: 7,
  },
  elapsed: {
    fontFamily: fonts.mono,
    fontSize: typeScale.heading,
    fontVariant: ["tabular-nums"],
  },
  stop: {
    fontSize: typeScale.bodySm,
    fontWeight: "600",
  },
});
