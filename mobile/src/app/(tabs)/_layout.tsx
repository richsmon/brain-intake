import { Tabs } from "expo-router";

export default function TabsLayout() {
  return (
    <Tabs>
      <Tabs.Screen name="index" options={{ title: "Capture" }} />
      <Tabs.Screen name="items" options={{ title: "Items" }} />
    </Tabs>
  );
}
