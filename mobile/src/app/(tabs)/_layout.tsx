import { Link, Tabs } from "expo-router";
import { StyleSheet, Text } from "react-native";

function SettingsLink() {
  return (
    <Link href="/settings" style={styles.gear}>
      <Text style={styles.gearIcon}>⚙️</Text>
    </Link>
  );
}

export default function TabsLayout() {
  return (
    <Tabs screenOptions={{ headerRight: () => <SettingsLink /> }}>
      <Tabs.Screen name="index" options={{ title: "Capture" }} />
      <Tabs.Screen name="items" options={{ title: "Items" }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  gear: {
    marginRight: 16,
  },
  gearIcon: {
    fontSize: 18,
  },
});
