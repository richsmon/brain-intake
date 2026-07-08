import { render, screen } from "@testing-library/react-native";

import ItemsScreen from "../src/app/(tabs)/items";

jest.mock("expo-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => children,
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
      },
      { id: "2026-07-08-ffff0000", state: "open", lastEvent: "queued" },
    ],
  })),
}));

describe("ItemsScreen", () => {
  it("renders local pending ahead of server items with state chips", async () => {
    await render(<ItemsScreen />);
    expect(await screen.findByText("voice capture")).toBeOnTheScreen();
    expect(screen.getByText("queued (phone)")).toBeOnTheScreen();
    expect(screen.getByText("BI-1 acceptance smoke")).toBeOnTheScreen();
    expect(screen.getByText("became")).toBeOnTheScreen();
    expect(screen.getByText("2026-07-08-ffff0000")).toBeOnTheScreen();
    expect(screen.getByText("open")).toBeOnTheScreen();
  });
});
