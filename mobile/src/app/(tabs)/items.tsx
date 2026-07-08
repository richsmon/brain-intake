import { Link } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";

import { flushQueue, getApi, pendingEntries } from "../../lib/brain";
import type { ItemSummary } from "../../lib/api";
import { mergeItems, type DisplayItem } from "../../lib/state";

const STATE_COLORS: Record<string, string> = {
  became: "#2e7d32",
  "needs-human": "#e65100",
  "queued (phone)": "#757575",
};

function ItemRow({ item }: { item: DisplayItem }) {
  const row = (
    <View style={styles.row}>
      <Text style={styles.title} numberOfLines={1}>
        {item.title ?? item.id}
      </Text>
      <Text style={[styles.state, { color: STATE_COLORS[item.state] ?? "#1565c0" }]}>
        {item.state}
      </Text>
    </View>
  );
  if (item.local) return row;
  return (
    <Link href={{ pathname: "/item/[id]", params: { id: item.id } }} asChild>
      <Pressable>{row}</Pressable>
    </Link>
  );
}

export default function ItemsScreen() {
  const [items, setItems] = useState<DisplayItem[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const local = await pendingEntries();
    let server: ItemSummary[] = [];
    try {
      server = await (await getApi()).listItems();
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

  return (
    <FlatList
      data={items}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => <ItemRow item={item} />}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
      ListEmptyComponent={<Text style={styles.empty}>No items yet — capture something.</Text>}
      contentContainerStyle={items.length === 0 ? styles.emptyContainer : undefined}
    />
  );
}

const styles = StyleSheet.create({
  row: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#ddd",
    gap: 2,
  },
  title: {
    fontSize: 15,
    fontWeight: "500",
  },
  state: {
    fontSize: 12,
    fontWeight: "600",
  },
  empty: {
    textAlign: "center",
    color: "#757575",
  },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
  },
});
