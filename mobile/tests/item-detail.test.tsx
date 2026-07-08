import { fireEvent, render, screen } from "@testing-library/react-native";
import * as Clipboard from "expo-clipboard";

import ItemDetailScreen from "../src/app/item/[id]";

jest.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ id: "2026-07-08-6683abec" }),
}));

jest.mock("expo-clipboard", () => ({
  setStringAsync: jest.fn(async () => true),
}));

jest.mock("../src/lib/brain", () => ({
  getApi: jest.fn(async () => ({
    itemDetail: async (id: string) => ({
      id,
      state: "became",
      events: [
        { ts: "2026-07-08T11:30:41Z", event: "captured", source: "text", sha: "6683abec" },
        { ts: "2026-07-08T11:30:41Z", event: "queued" },
        {
          ts: "2026-07-08T11:31:29Z",
          event: "became",
          artifact: "workspaces/universal-brain/knowledge/note.md",
          kind: "note",
        },
      ],
      payload: { name: "payload.md", bytes: 235 },
    }),
  })),
}));

describe("ItemDetailScreen", () => {
  it("renders the full event timeline and copies the artifact path on tap", async () => {
    await render(<ItemDetailScreen />);
    expect(await screen.findByText("2026-07-08-6683abec")).toBeOnTheScreen();
    expect(screen.getByText("captured")).toBeOnTheScreen();
    expect(screen.getByText("queued")).toBeOnTheScreen();
    expect(screen.getByText("became")).toBeOnTheScreen();
    expect(screen.getByText("source: text · sha: 6683abec")).toBeOnTheScreen();

    await fireEvent.press(screen.getByText("Artifact (tap to copy)"));
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(
      "workspaces/universal-brain/knowledge/note.md",
    );
    expect(await screen.findByText("Artifact (copied ✓)")).toBeOnTheScreen();
  });
});
