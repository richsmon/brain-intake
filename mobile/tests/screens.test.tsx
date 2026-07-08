import { render, screen } from "@testing-library/react-native";

import ItemsScreen from "../src/app/(tabs)/items";
import ItemDetailScreen from "../src/app/item/[id]";

jest.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ id: "test-id" }),
}));

describe("screen placeholders", () => {
  it("renders the Items screen", async () => {
    await render(<ItemsScreen />);
    expect(screen.getByText("Items")).toBeOnTheScreen();
  });

  it("renders the item detail screen with its id", async () => {
    await render(<ItemDetailScreen />);
    expect(screen.getByText("Item test-id")).toBeOnTheScreen();
  });
});
