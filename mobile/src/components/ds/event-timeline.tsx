// The event timeline — the design's signature element. Every item is its
// append-only trail; the timeline renders it verbatim: mono event names,
// state-colored dots, timestamps, extras. No screen may invent state that
// isn't derivable from this trail.

import { StyleSheet, Text, View } from "react-native";

import { useTheme } from "../../theme";
import { eventStateVisual, fonts, spacing, typeScale } from "../../theme/tokens";

export interface TimelineEvent {
  event: string;
  ts?: string;
  extras?: string;
}

export function EventTimeline({ events }: { events: TimelineEvent[] }) {
  const { colors } = useTheme();
  return (
    <View style={styles.list}>
      {events.map((entry, index) => {
        const visual = eventStateVisual(entry.event);
        const color = colors[visual.colorKey];
        const isLast = index === events.length - 1;
        return (
          <View key={`${entry.event}-${index}`} style={styles.row}>
            <View style={styles.rail}>
              <View style={[styles.dot, { backgroundColor: color }]} />
              {!isLast && <View style={[styles.line, { backgroundColor: colors.line }]} />}
            </View>
            <View style={styles.body}>
              <View style={styles.head}>
                <Text style={[styles.name, { color }]}>{entry.event}</Text>
                {entry.ts ? <Text style={[styles.ts, { color: colors.ink3 }]}>{entry.ts}</Text> : null}
              </View>
              {entry.extras ? (
                <Text style={[styles.extras, { color: colors.ink2 }]}>{entry.extras}</Text>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  list: {
    gap: 0,
  },
  row: {
    flexDirection: "row",
    gap: spacing.s3,
  },
  rail: {
    alignItems: "center",
    width: 10,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginTop: 4,
  },
  line: {
    flex: 1,
    width: 2,
    marginVertical: 2,
  },
  body: {
    flex: 1,
    paddingBottom: spacing.s4,
    gap: 2,
  },
  head: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: spacing.s2,
  },
  name: {
    fontFamily: fonts.mono,
    fontSize: typeScale.bodySm,
    fontWeight: "600",
  },
  ts: {
    fontFamily: fonts.mono,
    fontSize: typeScale.label - 1,
    marginLeft: "auto",
  },
  extras: {
    fontSize: typeScale.bodySm,
    lineHeight: typeScale.bodySm * 1.45,
  },
});
