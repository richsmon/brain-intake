import { fireEvent, render, screen } from "@testing-library/react-native";
import { Text } from "react-native";

import type { SettingsStore } from "../src/lib/settings";
import { EVENT_STATES, eventStateVisual, palettes, radii, spacing, typeScale } from "../src/theme/tokens";
import { ThemeProvider, useTheme } from "../src/theme";

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

describe("tokens", () => {
  it("carries the DS palettes — dark is warm near-black, light is paper", () => {
    expect(palettes.dark.bgCanvas).toBe("#14100B");
    expect(palettes.light.bgCanvas).toBe("#F4EEE3");
    expect(palettes.dark.accent).toBe("#E8A33D");
    expect(palettes.light.accent).toBe("#A85B08");
  });

  it("exposes every event-state color in both themes", () => {
    for (const state of Object.keys(EVENT_STATES)) {
      const { colorKey, softKey } = EVENT_STATES[state as keyof typeof EVENT_STATES];
      expect(palettes.dark[colorKey]).toMatch(/^#|^rgba/);
      expect(palettes.light[colorKey]).toMatch(/^#|^rgba/);
      expect(palettes.dark[softKey]).toMatch(/^#|^rgba/);
    }
  });

  it("maps event states to mono glyphs per the DS", () => {
    expect(eventStateVisual("queued").glyph).toBe("○");
    expect(eventStateVisual("classified").glyph).toBe("◐");
    expect(eventStateVisual("routed").glyph).toBe("→");
    expect(eventStateVisual("became").glyph).toBe("✦");
    expect(eventStateVisual("needs-human").glyph).toBe("●");
    expect(eventStateVisual("transcribed").glyph).toBe("≋");
  });

  it("falls back to queued visuals for unknown states", () => {
    expect(eventStateVisual("queued (phone)").glyph).toBe("○");
    expect(eventStateVisual("whatever").colorKey).toBe("stateQueued");
  });

  it("carries DS ergonomics: capture radius 22, hit targets 44/96, title 17", () => {
    expect(radii.capture).toBe(22);
    expect(spacing.hitMin).toBe(44);
    expect(spacing.hitCapture).toBe(96);
    expect(typeScale.title).toBe(17);
  });
});

function Probe() {
  const { colors, preference, scheme } = useTheme();
  return <Text>{`${preference}:${scheme}:${colors.bgCanvas}`}</Text>;
}

describe("ThemeProvider", () => {
  it("follows the system scheme by default", async () => {
    await render(
      <ThemeProvider systemScheme="dark" settingsStore={memoryStore()}>
        <Probe />
      </ThemeProvider>,
    );
    await screen.findByText("system:dark:#14100B");
  });

  it("applies and persists a manual override", async () => {
    const store = memoryStore();
    function LightSwitch() {
      const t = useTheme();
      return <Text onPress={() => t.setPreference("light")}>go-light</Text>;
    }
    await render(
      <ThemeProvider systemScheme="dark" settingsStore={store}>
        <LightSwitch />
        <Probe />
      </ThemeProvider>,
    );
    await screen.findByText("system:dark:#14100B");
    await fireEvent.press(screen.getByText("go-light"));
    await screen.findByText("light:light:#F4EEE3");
    expect(store.data.get("brain.theme")).toBe("light");
  });

  it("restores a persisted preference on mount", async () => {
    const store = memoryStore();
    store.data.set("brain.theme", "light");
    await render(
      <ThemeProvider systemScheme="dark" settingsStore={store}>
        <Probe />
      </ThemeProvider>,
    );
    await screen.findByText("light:light:#F4EEE3");
  });
});
