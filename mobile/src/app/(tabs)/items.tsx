// Read (R1) — the stream: every captured item with its current state. A living
// record, not a dead list; tapping a server item opens its event trail (R2).

import { router } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { FlatList, RefreshControl, View } from "react-native";

import { DigestCard } from "../../components/ds/digest-card";
import { EmptyState } from "../../components/ds/empty-state";
import { ItemRow } from "../../components/ds/item-row";
import { OfflineBadge } from "../../components/ds/offline-badge";
import { ScreenHeader } from "../../components/ds/screen-header";
import type { Digest, ItemSummary } from "../../lib/api";
import { flushQueue, getApi, pendingEntries } from "../../lib/brain";
import { mergeItems, type DisplayItem } from "../../lib/state";
import { useTheme } from "../../theme";

export default function ItemsScreen() {
  const { colors } = useTheme();
  const [items, setItems] = useState<DisplayItem[]>([]);
  const [digest, setDigest] = useState<Digest | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const local = await pendingEntries();
    let server: ItemSummary[] = [];
    try {
      const api = await getApi();
      server = await api.listItems();
      setDigest(await api.digest().catch(() => null));
    } catch {
      // Offline — the local queue is still worth showing.
    }
    setItems(mergeItems(local, server));
  }, []);

  useEffect(() => {
    // On-mount load; every setState inside happens after an await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await flushQueue();
    await load();
    setRefreshing(false);
  }, [load]);

  const queued = items.filter((item) => item.local).length;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bgCanvas }}>
      <ScreenHeader title="Read">
        <OfflineBadge queued={queued} />
      </ScreenHeader>
      <FlatList
        ListHeaderComponent={digest ? (
          <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
            <DigestCard digest={digest} />
          </View>
        ) : null}
        data={items}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <ItemRow
            title={item.title ?? item.id}
            state={item.state}
            stateLabel={item.kind}
            onPress={
              item.local
                ? undefined
                : () => router.push({ pathname: "/item/[id]", params: { id: item.id } })
            }
          />
        )}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
        ListEmptyComponent={
          <EmptyState text="Nothing yet. Capture something and I'll take it from there." />
        }
      />
    </View>
  );
}
