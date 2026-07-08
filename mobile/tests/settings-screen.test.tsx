import { fireEvent, render, screen } from "@testing-library/react-native";

import SettingsScreen from "../src/app/settings";
import { getApi, settings } from "../src/lib/brain";

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

describe("SettingsScreen", () => {
  beforeEach(() => {
    setBaseUrlMock.mockClear();
    getApiMock.mockClear();
  });

  it("shows the stored base URL and a live health result", async () => {
    await render(<SettingsScreen />);
    const input = await screen.findByDisplayValue("http://100.96.207.63:8787");
    expect(input).toBeOnTheScreen();
    expect(await screen.findByText("ok — /Users/richsmon/code/universal-brain")).toBeOnTheScreen();
  });

  it("saves an edited URL and re-checks health", async () => {
    await render(<SettingsScreen />);
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
    await render(<SettingsScreen />);
    expect(await screen.findByText("unreachable")).toBeOnTheScreen();
  });
});
