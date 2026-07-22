// BI-C8: local-runs usage card atop Coding. Three period columns (today /
// 7 days / month), each with runs, compact in+out tokens and USD. Labeled
// honestly — these are totals of runs through the mini, NOT subscription
// limits, and the stamp says so.

import { StyleSheet, Text, View } from "react-native";

import {
  formatCost,
  formatTokenCount,
  type UsagePeriodTotals,
  type UsageSummary,
} from "../../lib/sessions";
import { useTheme } from "../../theme";
import { fonts, labelTracking, radii, spacing, typeScale } from "../../theme/tokens";

const PERIODS: readonly { key: keyof UsageSummary; label: string }[] = [
  { key: "today", label: "today" },
  { key: "last7d", label: "7 days" },
  { key: "thisMonth", label: "month" },
];

/** In + out only — cache reads would dwarf the number without meaning much. */
function tokensLine(t: UsagePeriodTotals): string {
  return `${formatTokenCount(t.input_tokens + t.output_tokens)} tok`;
}

export function UsageCard({ summary }: { summary: UsageSummary }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: colors.bgSurface, borderColor: colors.line }]}>
      <Text style={[styles.stamp, { color: colors.ink3 }]}>local runs · not plan limits</Text>
      <View style={styles.columns}>
        {PERIODS.map(({ key, label }) => {
          const t = summary[key];
          return (
            <View key={key} style={styles.column}>
              <Text style={[styles.periodLabel, { color: colors.ink3 }]}>{label}</Text>
              <Text style={[styles.runs, { color: colors.accent }]}>{t.runs}</Text>
              <Text style={[styles.detail, { color: colors.ink2 }]}>{tokensLine(t)}</Text>
              <Text style={[styles.detail, { color: colors.ink2 }]}>{formatCost(t.total_cost_usd)}</Text>
            </View>
          );
        })}
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
  stamp: {
    fontFamily: fonts.mono,
    fontSize: typeScale.label,
    letterSpacing: labelTracking / 2,
  },
  columns: {
    flexDirection: "row",
    gap: spacing.s6,
  },
  column: {
    gap: 1,
  },
  periodLabel: {
    fontFamily: fonts.mono,
    fontSize: typeScale.label - 1,
    letterSpacing: labelTracking,
    textTransform: "uppercase",
  },
  runs: {
    fontFamily: fonts.mono,
    fontSize: typeScale.heading,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  detail: {
    fontFamily: fonts.mono,
    fontSize: typeScale.label,
    fontVariant: ["tabular-nums"],
  },
});
