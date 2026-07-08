// Consumes an incoming iOS share-sheet intent (cold or warm start), turns it
// into queue captures, then resets the intent so it never double-fires.
// Renders nothing; mounted once in the root layout.

import { useShareIntent } from "expo-share-intent";
import { useEffect } from "react";

import { captureFile, captureText } from "../lib/brain";

export default function ShareIntentHandler() {
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntent();

  useEffect(() => {
    if (!hasShareIntent) return;
    void (async () => {
      const text = shareIntent.webUrl ?? shareIntent.text;
      if (text) {
        await captureText(text, "share-sheet");
      }
      for (const file of shareIntent.files ?? []) {
        await captureFile({
          source: "photo",
          uri: file.path,
          name: file.fileName,
          sizeBytes: file.size ?? undefined,
        });
      }
      resetShareIntent();
    })();
  }, [hasShareIntent, shareIntent, resetShareIntent]);

  return null;
}
