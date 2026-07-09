// R2 Item detail — the event trail, verbatim. The artifact ref is the payoff:
// proof that a captured thought *became* something in the brain.

import * as Clipboard from "expo-clipboard";
import { useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { EventStateChip } from "../../components/ds/event-state-chip";
import { EventTimeline } from "../../components/ds/event-timeline";
import type { InboxEvent, ItemDetail } from "../../lib/api";
import { getApi } from "../../lib/brain";
import { useTheme } from "../../theme";
import { fonts, radii, spacing, typeScale } from "../../theme/tokens";

function eventExtras(event: InboxEvent): string {
  const extras = Object.entries(event)
    .filter(([key]) => key !== "ts" && key !== "event")
    .map(([key, value]) => `${key}: ${String(value)}`);
  return extras.join(" · ");
}

export default function ItemDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const [detail, setDetail] = useState<ItemDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const api = await getApi();
        setDetail(await api.itemDetail(id));
      } catch {
        setError("That item didn't load. Pull back and retry.");
      }
    })();
  }, [id]);

  if (error) return <Text style={[styles.message, { color: colors.danger }]}>{error}</Text>;
  if (!detail) return <Text style={[styles.message, { color: colors.ink3 }]}>Loading…</Text>;

  const became = detail.events.find((event) => event.event === "became");
  const artifact = became?.artifact as string | undefined;
  const becameKind = typeof became?.kind === "string" ? became.kind : undefined;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={[styles.id, { color: colors.ink3 }]}>{detail.id}</Text>
      <View style={styles.headRow}>
        <EventStateChip state={detail.state} label={becameKind} />
        <Text style={[styles.payload, { color: colors.ink3 }]}>
          {detail.payload.name} · {detail.payload.bytes} B
        </Text>
      </View>
      {detail.transcript ? (
        <View style={[styles.card, { backgroundColor: colors.bgSurface, borderColor: colors.line }]}>
          <Text style={[styles.transcriptLabel, { color: colors.ink3 }]}>
            Transcript · audio is source of truth
          </Text>
          <Text style={[styles.transcript, { color: colors.ink2 }]}>
            “{detail.transcript.trim()}”
          </Text>
        </View>
      ) : null}
      <View
        style={[styles.card, { backgroundColor: colors.bgSurface, borderColor: colors.line }]}
      >
        <EventTimeline
          events={detail.events.map((event) => ({
            event: event.event,
            ts: event.ts,
            extras: eventExtras(event) || undefined,
          }))}
        />
      </View>
      {artifact ? (
        <Pressable
          style={({ pressed }) => [
            styles.artifact,
            {
              borderColor: colors.stateBecame,
              backgroundColor: pressed ? colors.stateBecameSoft : colors.bgSurface,
            },
          ]}
          onPress={() => {
            void Clipboard.setStringAsync(artifact);
            setCopied(true);
          }}
        >
          <Text style={[styles.artifactLabel, { color: colors.stateBecame }]}>
            Artifact {copied ? "(copied ✓)" : "(tap to copy)"}
          </Text>
          <Text style={[styles.artifactPath, { color: colors.ink1 }]}>{artifact}</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: spacing.s4,
    gap: spacing.s3,
  },
  id: {
    fontFamily: fonts.mono,
    fontSize: typeScale.caption,
  },
  headRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.s3,
  },
  payload: {
    fontFamily: fonts.mono,
    fontSize: typeScale.label,
  },
  card: {
    borderWidth: 1,
    borderRadius: radii.card,
    padding: spacing.s4,
    paddingBottom: 0,
  },
  transcriptLabel: {
    fontFamily: fonts.mono,
    fontSize: typeScale.label - 1,
    letterSpacing: 1,
    textTransform: "uppercase",
    fontWeight: "600",
    marginBottom: spacing.s2,
  },
  transcript: {
    fontSize: typeScale.bodySm,
    lineHeight: typeScale.bodySm * 1.5,
    fontStyle: "italic",
    paddingBottom: spacing.s4,
  },
  artifact: {
    borderWidth: 1,
    borderRadius: radii.card,
    padding: spacing.s3,
    gap: spacing.s1,
  },
  artifactLabel: {
    fontFamily: fonts.mono,
    fontSize: typeScale.label,
    fontWeight: "600",
  },
  artifactPath: {
    fontFamily: fonts.mono,
    fontSize: typeScale.bodySm,
  },
  message: {
    padding: spacing.s4,
    textAlign: "center",
  },
});
