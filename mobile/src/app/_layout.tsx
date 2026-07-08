import { Stack } from "expo-router";
import { useEffect } from "react";
import { AppState } from "react-native";

import ShareIntentHandler from "../components/share-intent-handler";
import { flushQueue } from "../lib/brain";

export default function RootLayout() {
  useEffect(() => {
    void flushQueue();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void flushQueue();
    });
    return () => subscription.remove();
  }, []);

  return (
    <>
      <ShareIntentHandler />
      <Stack>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="item/[id]" options={{ title: "Item" }} />
        <Stack.Screen name="settings" options={{ title: "Settings", presentation: "modal" }} />
      </Stack>
    </>
  );
}
