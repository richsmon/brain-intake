import { fireEvent, render, screen } from "@testing-library/react-native";
import { Alert } from "react-native";
import * as ImagePicker from "expo-image-picker";

import CaptureScreen from "../src/app/(tabs)/index";
import { captureFile } from "../src/lib/brain";
import { ThemeProvider } from "../src/theme";

jest.mock("../src/lib/brain", () => ({
  captureText: jest.fn(async () => undefined),
  captureFile: jest.fn(async () => ({ ok: true, ext: "jpg" })),
  pendingEntries: jest.fn(async () => []),
}));

jest.mock("expo-image-picker", () => ({
  requestCameraPermissionsAsync: jest.fn(async () => ({ granted: true })),
  launchCameraAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(async () => ({
    canceled: false,
    assets: [{ uri: "file:///photos/IMG_1.jpg", fileName: "IMG_1.jpg", fileSize: 1234 }],
  })),
}));

const mockRecorder = {
  record: jest.fn(),
  stop: jest.fn(async () => undefined),
  prepareToRecordAsync: jest.fn(async () => undefined),
  uri: "file:///recordings/note.m4a",
  currentTime: 0,
};

jest.mock("expo-audio", () => ({
  RecordingPresets: { HIGH_QUALITY: {} },
  requestRecordingPermissionsAsync: jest.fn(async () => ({ granted: true })),
  useAudioRecorder: () => mockRecorder,
}));

const captureFileMock = captureFile as jest.Mock;

/** The Photo target opens a native source sheet; auto-press one of its buttons. */
function autoPressAlertButton(label: string) {
  jest.spyOn(Alert, "alert").mockImplementation((_title, _message, buttons) => {
    buttons?.find((b) => b.text === label)?.onPress?.();
  });
}

function renderCapture() {
  return render(
    <ThemeProvider systemScheme="dark">
      <CaptureScreen />
    </ThemeProvider>,
  );
}

describe("CaptureScreen media capture", () => {
  beforeEach(() => {
    captureFileMock.mockClear();
    mockRecorder.record.mockClear();
    mockRecorder.stop.mockClear();
    jest.restoreAllMocks();
  });

  it("captures a library photo with name and size", async () => {
    autoPressAlertButton("Library");
    await renderCapture();
    await fireEvent.press(screen.getByText("Photo"));
    await screen.findByText("queued");
    expect(captureFileMock).toHaveBeenCalledWith({
      source: "photo",
      uri: "file:///photos/IMG_1.jpg",
      name: "IMG_1.jpg",
      sizeBytes: 1234,
    });
  });

  it("does nothing when the picker is canceled", async () => {
    (ImagePicker.launchImageLibraryAsync as jest.Mock).mockResolvedValueOnce({
      canceled: true,
      assets: null,
    });
    autoPressAlertButton("Library");
    await renderCapture();
    await fireEvent.press(screen.getByText("Photo"));
    expect(captureFileMock).not.toHaveBeenCalled();
  });

  it("records a voice note: record → stop → captureFile with the recorder uri", async () => {
    await renderCapture();
    await fireEvent.press(screen.getByText("Voice"));
    expect(mockRecorder.prepareToRecordAsync).toHaveBeenCalled();
    expect(mockRecorder.record).toHaveBeenCalled();
    await fireEvent.press(await screen.findByText("Stop"));
    expect(mockRecorder.stop).toHaveBeenCalled();
    await screen.findByText("queued");
    expect(captureFileMock).toHaveBeenCalledWith({
      source: "voice",
      uri: "file:///recordings/note.m4a",
      cloud: false,
    });
  });

  it("surfaces a rejected file check as a real error, in the danger register", async () => {
    captureFileMock.mockResolvedValueOnce({ ok: false, reason: "File too large (max 25 MB)" });
    autoPressAlertButton("Library");
    await renderCapture();
    await fireEvent.press(screen.getByText("Photo"));
    expect(await screen.findByText("File too large (max 25 MB)")).toBeOnTheScreen();
  });
});
