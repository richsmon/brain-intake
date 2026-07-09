import { Tabs } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ModeBar, type ModeName } from "../../components/ds/mode-bar";
import { useTheme } from "../../theme";

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
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
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
      tabBar={(props) => <ModeBarTabs {...props} />}
    >
      <Tabs.Screen name="items" options={{ title: "Read" }} />
      <Tabs.Screen name="index" options={{ title: "Capture" }} />
      <Tabs.Screen name="act" options={{ title: "Act" }} />
    </Tabs>
  );
}
