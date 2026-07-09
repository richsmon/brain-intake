import { fireEvent, render, screen } from "@testing-library/react-native";

import CaptureScreen from "../src/app/(tabs)/index";
import { captureText } from "../src/lib/brain";
import { ThemeProvider } from "../src/theme";

jest.mock("../src/lib/brain", () => ({
  captureText: jest.fn(async () => undefined),
  captureFile: jest.fn(async () => ({ ok: true, ext: "jpg" })),
  pendingEntries: jest.fn(async () => []),
}));

jest.mock("expo-image-picker", () => ({
  requestCameraPermissionsAsync: jest.fn(async () => ({ granted: true })),
  launchCameraAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
}));

jest.mock("expo-audio", () => ({
  RecordingPresets: { HIGH_QUALITY: {} },
  requestRecordingPermissionsAsync: jest.fn(async () => ({ granted: true })),
  useAudioRecorder: () => ({
    record: jest.fn(),
    stop: jest.fn(async () => undefined),
    prepareToRecordAsync: jest.fn(async () => undefined),
    uri: null,
    currentTime: 0,
  }),
}));

const captureTextMock = captureText as jest.Mock;

function renderCapture() {
  return render(
    <ThemeProvider systemScheme="dark">
      <CaptureScreen />
    </ThemeProvider>,
  );
}

describe("CaptureScreen", () => {
  beforeEach(() => captureTextMock.mockClear());

  it("saves a trimmed text note, clears the input, confirms with a queued chip", async () => {
    await renderCapture();
    const input = screen.getByPlaceholderText("Text note…");
    await fireEvent.changeText(input, "  remember this  ");
    await fireEvent.press(screen.getByText("Save to brain"));
    await screen.findByText("queued");
    expect(captureTextMock).toHaveBeenCalledWith("remember this");
    expect(input.props.value).toBe("");
  });

  it("hides the save action while the input is empty — nothing to save, nothing to press", async () => {
    await renderCapture();
    expect(screen.queryByText("Save to brain")).toBeNull();
    expect(captureTextMock).not.toHaveBeenCalled();
  });

  it("shows the three instrument-register capture targets", async () => {
    await renderCapture();
    screen.getByText("Text");
    screen.getByText("Voice");
    screen.getByText("Photo");
  });
});
