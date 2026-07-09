import { fireEvent, render, screen } from "@testing-library/react-native";

import SettingsScreen from "../src/app/settings";
import { getApi, settings } from "../src/lib/brain";
import type { SettingsStore } from "../src/lib/settings";
import { ThemeProvider } from "../src/theme";

jest.mock("../src/lib/brain", () => ({
  settings: {
    getBaseUrl: jest.fn(async () => "http://100.96.207.63:8787"),
    setBaseUrl: jest.fn(async () => undefined),
  },
  getApi: jest.fn(async () => ({
    health: async () => ({ ok: true, brainRoot: "/Users/richsmon/code/universal-brain" }),
  })),
}));

const setBaseUrlMock = settings.setBaseUrl as jest.Mock;
const getApiMock = getApi as jest.Mock;

function memoryStore(): SettingsStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => {
      data.set(k, v);
    },
  };
}

function renderSettings(store = memoryStore()) {
  return render(
    <ThemeProvider systemScheme="dark" settingsStore={store}>
      <SettingsScreen />
    </ThemeProvider>,
  );
}

describe("SettingsScreen", () => {
  beforeEach(() => {
    setBaseUrlMock.mockClear();
    getApiMock.mockClear();
  });

  it("shows the stored base URL and a live health result", async () => {
    await renderSettings();
    const input = await screen.findByDisplayValue("http://100.96.207.63:8787");
    expect(input).toBeOnTheScreen();
    expect(await screen.findByText("ok — /Users/richsmon/code/universal-brain")).toBeOnTheScreen();
  });

  it("saves an edited URL and re-checks health", async () => {
    await renderSettings();
    const input = await screen.findByDisplayValue("http://100.96.207.63:8787");
    await fireEvent.changeText(input, "http://other:8787");
    await fireEvent.press(screen.getByText("Save"));
    await screen.findByText("ok — /Users/richsmon/code/universal-brain");
    expect(setBaseUrlMock).toHaveBeenCalledWith("http://other:8787");
  });

  it("shows unreachable when health fails", async () => {
    getApiMock.mockResolvedValueOnce({
      health: async () => {
        throw new Error("down");
      },
    });
    await renderSettings();
    expect(await screen.findByText("unreachable")).toBeOnTheScreen();
  });

  it("persists the theme preference from the picker", async () => {
    const store = memoryStore();
    await renderSettings(store);
    await fireEvent.press(await screen.findByText("Light"));
    expect(store.data.get("brain.theme")).toBe("light");
  });
});
