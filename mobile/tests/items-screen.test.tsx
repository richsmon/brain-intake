import { render, screen } from "@testing-library/react-native";

import ItemsScreen from "../src/app/(tabs)/items";
import { ThemeProvider } from "../src/theme";

jest.mock("expo-router", () => ({
  router: { push: jest.fn() },
}));

jest.mock("../src/lib/brain", () => ({
  flushQueue: jest.fn(async () => null),
  pendingEntries: jest.fn(async () => [
    {
      id: "q-local-1",
      kind: "voice",
      source: "voice",
      ext: "m4a",
      deviceTs: "2026-07-08T12:00:00Z",
      createdAt: "2026-07-08T12:00:00Z",
      tries: 0,
    },
  ]),
  getApi: jest.fn(async () => ({
    listItems: async () => [
      {
        id: "2026-07-08-6683abec",
        state: "became",
        lastEvent: "became",
        title: "BI-1 acceptance smoke",
        kind: "note",
      },
      { id: "2026-07-08-ffff0000", state: "open", lastEvent: "queued" },
    ],
  })),
}));

describe("ItemsScreen", () => {
  it("renders local pending ahead of server items with state chips", async () => {
    await render(
      <ThemeProvider systemScheme="dark">
        <ItemsScreen />
      </ThemeProvider>,
    );
    expect(await screen.findByText("voice capture")).toBeOnTheScreen();
    expect(screen.getByText("queued (phone)")).toBeOnTheScreen();
    expect(screen.getByText("BI-1 acceptance smoke")).toBeOnTheScreen();
    // The became chip says WHAT the item became, not the raw event word.
    expect(screen.getByText("note")).toBeOnTheScreen();
    expect(screen.queryByText("became")).toBeNull();
    expect(screen.getByText("2026-07-08-ffff0000")).toBeOnTheScreen();
    expect(screen.getByText("open")).toBeOnTheScreen();
  });
});
