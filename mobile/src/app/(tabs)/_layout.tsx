import { Tabs } from "expo-router";

import { ModeBar, type ModeName } from "../../components/ds/mode-bar";

// Structural subset of @react-navigation/bottom-tabs' BottomTabBarProps —
// not a direct dependency, expo-router provides it at runtime.
interface TabBarProps {
  state: { index: number; routes: { name: string }[] };
  navigation: { navigate: (name: string) => void };
}

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

function ModeBarTabs({ state, navigation }: TabBarProps) {
  const activeRoute = state.routes[state.index]?.name ?? "index";
  return (
    <ModeBar
      active={ROUTE_TO_MODE[activeRoute] ?? "capture"}
      onChange={(mode) => navigation.navigate(MODE_TO_ROUTE[mode])}
    />
  );
}

export default function TabsLayout() {
  return (
    <Tabs
      initialRouteName="index"
      screenOptions={{ headerShown: false }}
      tabBar={(props) => <ModeBarTabs {...props} />}
    >
      <Tabs.Screen name="items" options={{ title: "Read" }} />
      <Tabs.Screen name="index" options={{ title: "Capture" }} />
      <Tabs.Screen name="act" options={{ title: "Act" }} />
    </Tabs>
  );
}
