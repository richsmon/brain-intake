import * as Clipboard from "expo-clipboard";
import { useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { getApi } from "../../lib/brain";
import type { InboxEvent, ItemDetail } from "../../lib/api";

function eventExtras(event: InboxEvent): string {
  const extras = Object.entries(event)
    .filter(([key]) => key !== "ts" && key !== "event")
    .map(([key, value]) => `${key}: ${String(value)}`);
  return extras.join(" · ");
}

export default function ItemDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [detail, setDetail] = useState<ItemDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const api = await getApi();
        setDetail(await api.itemDetail(id));
      } catch {
        setError("Failed to load item");
      }
    })();
  }, [id]);

  if (error) return <Text style={styles.error}>{error}</Text>;
  if (!detail) return <Text style={styles.loading}>Loading…</Text>;

  const artifact = detail.events.find((event) => event.event === "became")?.artifact as
    | string
    | undefined;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.id}>{detail.id}</Text>
      <Text style={styles.meta}>
        {detail.state} · {detail.payload.name} ({detail.payload.bytes} B)
      </Text>
      <View style={styles.timeline}>
        {detail.events.map((event, index) => (
          <View key={index} style={styles.event}>
            <Text style={styles.eventName}>{event.event}</Text>
            <Text style={styles.eventTs}>{event.ts}</Text>
            {eventExtras(event) ? <Text style={styles.eventExtras}>{eventExtras(event)}</Text> : null}
          </View>
        ))}
      </View>
      {artifact ? (
        <Pressable
          style={styles.artifact}
          onPress={() => {
            void Clipboard.setStringAsync(artifact);
            setCopied(true);
          }}
        >
          <Text style={styles.artifactLabel}>Artifact {copied ? "(copied ✓)" : "(tap to copy)"}</Text>
          <Text style={styles.artifactPath}>{artifact}</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 16,
    gap: 12,
  },
  id: {
    fontSize: 16,
    fontWeight: "600",
  },
  meta: {
    color: "#757575",
  },
  timeline: {
    gap: 10,
  },
  event: {
    borderLeftWidth: 2,
    borderLeftColor: "#208AEF",
    paddingLeft: 10,
    gap: 2,
  },
  eventName: {
    fontWeight: "600",
  },
  eventTs: {
    fontSize: 12,
    color: "#757575",
  },
  eventExtras: {
    fontSize: 13,
  },
  artifact: {
    borderWidth: 1,
    borderColor: "#2e7d32",
    borderRadius: 8,
    padding: 12,
    gap: 4,
  },
  artifactLabel: {
    fontWeight: "600",
    color: "#2e7d32",
  },
  artifactPath: {
    fontSize: 13,
  },
  loading: {
    padding: 16,
    textAlign: "center",
  },
  error: {
    padding: 16,
    textAlign: "center",
    color: "#c62828",
  },
});
