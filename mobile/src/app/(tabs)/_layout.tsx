import { Tabs } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ModeBar, type ModeName } from "../../components/ds/mode-bar";
import type { ItemSummary } from "../../lib/api";
import { getApi } from "../../lib/brain";
import { loadSeenIds, markBecameSeen, unseenBecameCount } from "../../lib/read-badge";
import { useTheme } from "../../theme";

const ROUTE_TO_MODE: Record<string, ModeName> = {
  items: "read",
  index: "capture",
  act: "act",
};

const MODE_TO_ROUTE: Record<ModeName, string> = {
  read: "items",
  capture: "index",
  act: "act",
};

// Structural subset of @react-navigation/bottom-tabs' BottomTabBarProps —
// not a direct dependency, expo-router provides it at runtime.
interface TabBarProps {
  state: { index: number; routes: { name: string }[] };
  navigation: { navigate: (name: string) => void };
}

/** Read = new-`became` since last look; Act = live pending count. Offline → 0. */
function useBadges() {
  const [count, setCount] = useState(0);
  const [actCount, setActCount] = useState(0);
  const itemsRef = useRef<ItemSummary[]>([]);

  const refresh = useCallback(async () => {
    try {
      const api = await getApi();
      const items = await api.listItems();
      itemsRef.current = items;
      setCount(unseenBecameCount(items, await loadSeenIds()));
      const [questions, approvals, cloudApprovals] = await Promise.all([
        api.listQuestions(),
        api.listApprovals().catch(() => []),
        api.listCloudApprovals().catch(() => []),
      ]);
      setActCount(questions.length + approvals.length + cloudApprovals.length);
    } catch {
      // Offline — no badge is the honest answer.
    }
  }, []);

  useEffect(() => {
    // TODO(v1.1 debt): refresh() is async — setState lands post-await, but the
    // react-compiler rule flags the call site; restructure at the next Act pass.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  const markRead = useCallback(() => {
    setCount(0);
    void markBecameSeen(itemsRef.current);
  }, []);

  return { count, actCount, markRead };
}

export default function TabsLayout() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { count: readBadge, actCount: actBadge, markRead } = useBadges();

  const renderTabBar = ({ state, navigation }: TabBarProps) => {
    const activeRoute = state.routes[state.index]?.name ?? "index";
    return (
      <ModeBar
        active={ROUTE_TO_MODE[activeRoute] ?? "capture"}
        readBadge={readBadge}
        actBadge={actBadge}
        onChange={(mode) => {
          if (mode === "read") markRead();
          navigation.navigate(MODE_TO_ROUTE[mode]);
        }}
      />
    );
  };

  return (
    <Tabs
      initialRouteName="index"
      // sceneStyle themes the tab navigator's own scene container — the Stack's
      // contentStyle does NOT reach it (the white-background TF6 lesson). Tab
      // screens hide the native header, so the top safe-area inset lives here.
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: colors.bgCanvas, paddingTop: insets.top },
      }}
      tabBar={renderTabBar}
    >
      <Tabs.Screen name="items" options={{ title: "Read" }} />
      <Tabs.Screen name="index" options={{ title: "Capture" }} />
      <Tabs.Screen name="act" options={{ title: "Act" }} />
    </Tabs>
  );
}
