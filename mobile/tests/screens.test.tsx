import { render, screen } from "@testing-library/react-native";

import CaptureScreen from "../src/app/(tabs)/index";
import ItemsScreen from "../src/app/(tabs)/items";
import SettingsScreen from "../src/app/settings";

describe("screen placeholders", () => {
  it("renders the Capture screen", async () => {
    await render(<CaptureScreen />);
    expect(screen.getByText("Capture")).toBeOnTheScreen();
  });

  it("renders the Items screen", async () => {
    await render(<ItemsScreen />);
    expect(screen.getByText("Items")).toBeOnTheScreen();
  });

  it("renders the Settings screen", async () => {
    await render(<SettingsScreen />);
    expect(screen.getByText("Settings")).toBeOnTheScreen();
  });
});
