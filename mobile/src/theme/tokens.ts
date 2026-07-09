// Brainer design tokens — 1:1 from the DS bundle (universal-brain:
// workspaces/brain-intake/design/system/_ds/.../tokens/*.css).
// Warm ink/amber "control room". Dark is the default theme.
// Never hardcode hex in screens — consume via useTheme().

export interface Palette {
  bgCanvas: string;
  bgSurface: string;
  bgSurface2: string;
  bgInverse: string;
  ink1: string;
  ink2: string;
  ink3: string;
  inkInverse: string;
  line: string;
  lineStrong: string;
  accent: string;
  accentStrong: string;
  accentSoft: string;
  stateQueued: string;
  stateClassified: string;
  stateRouted: string;
  stateBecame: string;
  stateNeedsHuman: string;
  stateQueuedSoft: string;
  stateClassifiedSoft: string;
  stateRoutedSoft: string;
  stateBecameSoft: string;
  stateNeedsHumanSoft: string;
  danger: string;
  success: string;
  offline: string;
  recording: string;
}

const dark: Palette = {
  bgCanvas: "#14100B",
  bgSurface: "#1D1712",
  bgSurface2: "#272019",
  bgInverse: "#EDE5D8",
  ink1: "#EDE5D8",
  ink2: "#A89D8C",
  ink3: "#756B5C",
  inkInverse: "#1F1A13",
  line: "#322B21",
  lineStrong: "#4A4032",
  accent: "#E8A33D",
  accentStrong: "#F5BC66",
  accentSoft: "rgba(232, 163, 61, 0.14)",
  stateQueued: "#8F8574",
  stateClassified: "#5FA79E",
  stateRouted: "#E8A33D",
  stateBecame: "#55B07C",
  stateNeedsHuman: "#E06A55",
  stateQueuedSoft: "rgba(143, 133, 116, 0.16)",
  stateClassifiedSoft: "rgba(95, 167, 158, 0.14)",
  stateRoutedSoft: "rgba(232, 163, 61, 0.14)",
  stateBecameSoft: "rgba(85, 176, 124, 0.14)",
  stateNeedsHumanSoft: "rgba(224, 106, 85, 0.14)",
  danger: "#E06A55",
  success: "#55B07C",
  offline: "#8F8574",
  recording: "#E06A55",
};

const light: Palette = {
  bgCanvas: "#F4EEE3",
  bgSurface: "#FCF8F0",
  bgSurface2: "#ECE4D4",
  bgInverse: "#1F1A13",
  ink1: "#211B13",
  ink2: "#6B6152",
  ink3: "#99907F",
  inkInverse: "#F4EEE3",
  line: "#DFD5C2",
  lineStrong: "#C4B79E",
  accent: "#A85B08",
  accentStrong: "#8A4A06",
  accentSoft: "rgba(168, 91, 8, 0.11)",
  stateQueued: "#857B69",
  stateClassified: "#2F6D65",
  stateRouted: "#A85B08",
  stateBecame: "#257A4A",
  stateNeedsHuman: "#B3402C",
  stateQueuedSoft: "rgba(133, 123, 105, 0.13)",
  stateClassifiedSoft: "rgba(47, 109, 101, 0.11)",
  stateRoutedSoft: "rgba(168, 91, 8, 0.11)",
  stateBecameSoft: "rgba(37, 122, 74, 0.11)",
  stateNeedsHumanSoft: "rgba(179, 64, 44, 0.11)",
  danger: "#B3402C",
  success: "#257A4A",
  offline: "#857B69",
  recording: "#B3402C",
};

export const palettes = { dark, light } as const;

// Event states: color AND form (mono glyph) so state reads at a glance and
// colorblind. Red is reserved for needs-human, recording, and real failures.
export const EVENT_STATES = {
  queued: { glyph: "○", colorKey: "stateQueued", softKey: "stateQueuedSoft" },
  classified: { glyph: "◐", colorKey: "stateClassified", softKey: "stateClassifiedSoft" },
  routed: { glyph: "→", colorKey: "stateRouted", softKey: "stateRoutedSoft" },
  became: { glyph: "✦", colorKey: "stateBecame", softKey: "stateBecameSoft" },
  "needs-human": { glyph: "●", colorKey: "stateNeedsHuman", softKey: "stateNeedsHumanSoft" },
  transcribed: { glyph: "≋", colorKey: "stateQueued", softKey: "stateQueuedSoft" },
} as const;

export type EventStateName = keyof typeof EVENT_STATES;

export interface EventStateVisual {
  glyph: string;
  colorKey: keyof Palette;
  softKey: keyof Palette;
}

export function eventStateVisual(state: string): EventStateVisual {
  if (state in EVENT_STATES) return EVENT_STATES[state as EventStateName];
  // Item-level states like "queued (phone)" resolve by prefix.
  const prefix = (Object.keys(EVENT_STATES) as EventStateName[]).find((s) => state.startsWith(s));
  return EVENT_STATES[prefix ?? "queued"];
}

// 4pt spacing base + ergonomics (values are pt).
export const spacing = {
  s1: 4,
  s2: 8,
  s3: 12,
  s4: 16,
  s5: 20,
  s6: 24,
  s8: 32,
  s10: 40,
  hitMin: 44,
  hitCapture: 96,
  thumbBottom: 34,
} as const;

export const radii = {
  chip: 999,
  control: 10,
  card: 14,
  capture: 22,
  sheet: 24,
} as const;

// Type scale (pt). Sans = system (humanist voice), mono = the system's own
// voice: event names, timestamps, ids, counts, section labels.
export const typeScale = {
  display: 28,
  heading: 22,
  title: 17,
  body: 15,
  bodySm: 13,
  caption: 12,
  label: 11,
} as const;

export const fonts = {
  sans: undefined as string | undefined, // system default
  mono: "Menlo",
} as const;

// Mono label treatment: 11pt uppercase; RN letterSpacing is pt, ≈0.1em.
export const labelTracking = 1.1;

export const motion = {
  instant: 90,
  quick: 160,
  settle: 240,
  recordPulse: 1200,
} as const;
