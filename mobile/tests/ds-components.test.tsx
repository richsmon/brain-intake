import { fireEvent, render, screen } from "@testing-library/react-native";
import type { ReactElement } from "react";

import { CaptureButton } from "../src/components/ds/capture-button";
import { EmptyState } from "../src/components/ds/empty-state";
import { EventStateChip } from "../src/components/ds/event-state-chip";
import { ItemRow } from "../src/components/ds/item-row";
import { OfflineBadge } from "../src/components/ds/offline-badge";
import { RecordingIndicator } from "../src/components/ds/recording-indicator";
import { ScreenHeader } from "../src/components/ds/screen-header";
import { UsageCard } from "../src/components/ds/usage-card";
import type { UsagePeriodTotals } from "../src/lib/sessions";
import { ThemeProvider } from "../src/theme";

function renderThemed(ui: ReactElement) {
  return render(<ThemeProvider systemScheme="dark">{ui}</ThemeProvider>);
}

describe("EventStateChip", () => {
  it("shows the mono glyph and the state label", async () => {
    await renderThemed(<EventStateChip state="became" />);
    screen.getByText("✦");
    screen.getByText("became");
  });

  it("resolves item-level states by prefix", async () => {
    await renderThemed(<EventStateChip state="queued (phone)" />);
    screen.getByText("○");
    screen.getByText("queued (phone)");
  });

  it("shows a meaningful label override while keeping the state visuals", async () => {
    await renderThemed(<EventStateChip state="became" label="note" />);
    screen.getByText("✦");
    screen.getByText("note");
    expect(screen.queryByText("became")).toBeNull();
  });
});

describe("ItemRow", () => {
  it("renders title, state chip, age and source; press opens the item", async () => {
    const onPress = jest.fn();
    await renderThemed(
      <ItemRow title="Voice note from the train" state="became" age="10h" source="voice" onPress={onPress} />,
    );
    screen.getByText("Voice note from the train");
    screen.getByText("became");
    screen.getByText("10h");
    await fireEvent.press(screen.getByText("Voice note from the train"));
    expect(onPress).toHaveBeenCalled();
  });
});

describe("OfflineBadge", () => {
  it("stays silent when nothing is queued", async () => {
    await renderThemed(<OfflineBadge queued={0} />);
    expect(screen.queryByText(/queued/)).toBeNull();
  });

  it("shows a quiet queued count when offline captures wait", async () => {
    await renderThemed(<OfflineBadge queued={3} />);
    screen.getByText("⌵ 3 queued");
  });
});

describe("EmptyState", () => {
  it("speaks in the companion voice", async () => {
    await renderThemed(<EmptyState text="Nothing needs you. I'll ask when something does." />);
    screen.getByText("Nothing needs you. I'll ask when something does.");
  });
});

describe("ScreenHeader", () => {
  it("renders the screen title", async () => {
    await renderThemed(<ScreenHeader title="Read" />);
    screen.getByText("Read");
  });
});

describe("CaptureButton", () => {
  it.each([
    ["text", "Text"],
    ["voice", "Voice"],
    ["photo", "Photo"],
  ] as const)("labels the %s target with a single word", async (kind, label) => {
    const onPress = jest.fn();
    await renderThemed(<CaptureButton kind={kind} onPress={onPress} />);
    await fireEvent.press(screen.getByText(label));
    expect(onPress).toHaveBeenCalled();
  });
});

describe("RecordingIndicator", () => {
  it("shows elapsed time and stops on press", async () => {
    const onStop = jest.fn();
    await renderThemed(<RecordingIndicator elapsed="0:07" onStop={onStop} />);
    screen.getByText("0:07");
    await fireEvent.press(screen.getByText(/stop/i));
    expect(onStop).toHaveBeenCalled();
  });
});

describe("UsageCard (BI-C8)", () => {
  const totals = (runs: number, input: number, output: number, cost: number): UsagePeriodTotals => ({
    runs,
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: 1000,
    cache_read_input_tokens: 500_000,
    total_cost_usd: cost,
  });

  it("shows runs, compact in+out tokens and USD per period, labeled as local runs", async () => {
    await renderThemed(
      <UsageCard
        summary={{
          today: totals(2, 12_000, 345, 0.43),
          last7d: totals(9, 2_000_000, 400_000, 12.5),
          thisMonth: totals(21, 8_000_000, 950, 40.129),
        }}
      />,
    );
    // Honest labeling — this is our own runs' spend, not subscription limits.
    screen.getByText("local runs · not plan limits");
    screen.getByText("today");
    screen.getByText("7 days");
    screen.getByText("month");
    // Tokens are in+out only — the 500k cache reads must NOT inflate the number.
    screen.getByText("2");
    screen.getByText("12.3k tok");
    screen.getByText("$0.43");
    screen.getByText("9");
    screen.getByText("2.4M tok");
    screen.getByText("$12.50");
    screen.getByText("21");
    screen.getByText("$40.13");
  });
});
