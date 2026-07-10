// R3 morning digest — the companion voice card atop Read. Reports like a
// competent chief of staff: counts up front, one idea per sentence.

import { StyleSheet, Text, View } from "react-native";

import type { Digest } from "../../lib/api";
import { useTheme } from "../../theme";
import { fonts, labelTracking, radii, spacing, typeScale } from "../../theme/tokens";

function headline(digest: Digest): string {
  const { counts } = digest;
  const parts: string[] = [];
  if (counts.captured === 0) parts.push("Nothing captured today yet.");
  else parts.push(`${counts.captured} captured today.`);
  const outcomes: string[] = [];
  if (counts.became > 0) outcomes.push(`${counts.became} became brain artifacts`);
  if (counts.categorized > 0) outcomes.push(`${counts.categorized} categorized`);
  if (outcomes.length > 0) parts.push(`${outcomes.join(", ")}.`);
  const pending = counts.needsHuman + counts.cloudApprovals;
  if (pending > 0) parts.push(`${pending} need${pending === 1 ? "s" : ""} you in Act.`);
  return parts.join(" ");
}

export function DigestCard({ digest }: { digest: Digest }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: colors.bgSurface, borderColor: colors.line }]}>
      <View style={styles.head}>
        <Text style={[styles.stamp, { color: colors.ink3 }]}>
          {digest.loopDisabled ? "loop halted" : `loop live · ${digest.lastReport ?? "no report yet"}`}
        </Text>
      </View>
      <Text style={[styles.headline, { color: colors.ink1 }]}>{headline(digest)}</Text>
      <View style={styles.stats}>
        {[
          { value: digest.counts.captured, label: "captured" },
          { value: digest.counts.became + digest.counts.categorized, label: "processed" },
          { value: digest.counts.needsHuman + digest.counts.cloudApprovals, label: "need you" },
        ].map((stat) => (
          <View key={stat.label} style={styles.stat}>
            <Text style={[styles.statValue, { color: colors.accent }]}>{stat.value}</Text>
            <Text style={[styles.statLabel, { color: colors.ink3 }]}>{stat.label}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: radii.card,
    padding: spacing.s4,
    gap: spacing.s3,
  },
  head: {
    flexDirection: "row",
  },
  stamp: {
    fontFamily: fonts.mono,
    fontSize: typeScale.label,
    letterSpacing: labelTracking / 2,
  },
  headline: {
    fontSize: typeScale.body,
    lineHeight: typeScale.body * 1.45,
  },
  stats: {
    flexDirection: "row",
    gap: spacing.s6,
  },
  stat: {
    gap: 1,
  },
  statValue: {
    fontFamily: fonts.mono,
    fontSize: typeScale.heading,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  statLabel: {
    fontFamily: fonts.mono,
    fontSize: typeScale.label - 1,
    letterSpacing: labelTracking,
    textTransform: "uppercase",
  },
});
