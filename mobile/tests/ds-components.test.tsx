import { fireEvent, render, screen } from "@testing-library/react-native";
import type { ReactElement } from "react";

import { CaptureButton } from "../src/components/ds/capture-button";
import { EmptyState } from "../src/components/ds/empty-state";
import { EventStateChip } from "../src/components/ds/event-state-chip";
import { ItemRow } from "../src/components/ds/item-row";
import { OfflineBadge } from "../src/components/ds/offline-badge";
import { RecordingIndicator } from "../src/components/ds/recording-indicator";
import { ScreenHeader } from "../src/components/ds/screen-header";
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
