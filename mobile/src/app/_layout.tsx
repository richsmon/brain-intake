import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { AppState } from "react-native";

import ShareIntentHandler from "../components/share-intent-handler";
import { flushQueue } from "../lib/brain";
import { registerNotifyTask, runNotifyPass } from "../lib/notify-runtime";
import { ThemeProvider, useTheme } from "../theme";

function ThemedApp() {
  const { colors, scheme } = useTheme();
  return (
    <>
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
      <ShareIntentHandler />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.bgCanvas },
          headerTintColor: colors.accent,
          headerTitleStyle: { color: colors.ink1 },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: colors.bgCanvas },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="item/[id]" options={{ title: "Item" }} />
        <Stack.Screen name="session/[id]" options={{ title: "Session" }} />
        <Stack.Screen name="settings" options={{ title: "Settings", presentation: "modal" }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  useEffect(() => {
    void flushQueue();
    void registerNotifyTask().then(() => runNotifyPass()).catch(() => {});
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void flushQueue();
        void runNotifyPass().catch(() => {});
      }
    });
    return () => subscription.remove();
  }, []);

  return (
    <ThemeProvider>
      <ThemedApp />
    </ThemeProvider>
  );
}
