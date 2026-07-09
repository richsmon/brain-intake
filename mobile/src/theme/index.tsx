// Theme context: resolves system/dark/light preference (persisted at
// brain.theme) into the active palette. Dark is the default when the system
// scheme is unknown — Capture is the home surface, car/night ergonomics.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useColorScheme } from "react-native";

import type { SettingsStore } from "../lib/settings";
import { palettes, type Palette } from "./tokens";

export type ThemePreference = "system" | "dark" | "light";
export type ThemeScheme = "dark" | "light";

const THEME_KEY = "brain.theme";

interface ThemeValue {
  colors: Palette;
  scheme: ThemeScheme;
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

export function ThemeProvider({
  children,
  systemScheme,
  settingsStore = AsyncStorage,
}: {
  children: ReactNode;
  /** Test seam; defaults to the device scheme (dark when unknown). */
  systemScheme?: ThemeScheme;
  settingsStore?: SettingsStore;
}) {
  const detected = useColorScheme();
  const system: ThemeScheme = systemScheme ?? (detected === "light" ? "light" : "dark");
  const [preference, setPreferenceState] = useState<ThemePreference>("system");

  useEffect(() => {
    let mounted = true;
    void settingsStore.getItem(THEME_KEY).then((value) => {
      if (mounted && (value === "system" || value === "dark" || value === "light")) {
        setPreferenceState(value);
      }
    });
    return () => {
      mounted = false;
    };
  }, [settingsStore]);

  const scheme: ThemeScheme = preference === "system" ? system : preference;

  const value = useMemo<ThemeValue>(
    () => ({
      colors: palettes[scheme],
      scheme,
      preference,
      setPreference: (next: ThemePreference) => {
        setPreferenceState(next);
        void settingsStore.setItem(THEME_KEY, next);
      },
    }),
    [scheme, preference, settingsStore],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme requires a <ThemeProvider> ancestor");
  return value;
}
