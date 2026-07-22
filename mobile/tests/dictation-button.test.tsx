import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";

import { DictationButton } from "../src/components/ds/dictation-button";
import { ApiError } from "../src/lib/api";
import { getSessionsApi } from "../src/lib/brain";
import { ThemeProvider } from "../src/theme";

const mockTranscribe = jest.fn(async () => ({ text: "fix the login flow " }));

jest.mock("../src/lib/brain", () => ({
  getSessionsApi: jest.fn(async () => ({ transcribe: mockTranscribe })),
}));

const mockRecorder = {
  record: jest.fn(),
  stop: jest.fn(async () => undefined),
  prepareToRecordAsync: jest.fn(async () => undefined),
  uri: "file:///recordings/dictation.m4a",
  currentTime: 0,
};

jest.mock("expo-audio", () => ({
  RecordingPresets: { HIGH_QUALITY: {} },
  requestRecordingPermissionsAsync: jest.fn(async () => ({ granted: true })),
  useAudioRecorder: () => mockRecorder,
}));

const getSessionsApiMock = getSessionsApi as jest.Mock;

async function renderButton(onTranscript = jest.fn(), onDictationError = jest.fn()) {
  await render(
    <ThemeProvider systemScheme="dark">
      <DictationButton onTranscript={onTranscript} onDictationError={onDictationError} />
    </ThemeProvider>,
  );
  return { onTranscript, onDictationError };
}

async function dictate() {
  await fireEvent.press(screen.getByLabelText("Dictate"));
  await fireEvent.press(await screen.findByLabelText("Stop dictation"));
}

describe("DictationButton", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getSessionsApiMock.mockImplementation(async () => ({ transcribe: mockTranscribe }));
    mockTranscribe.mockImplementation(async () => ({ text: "fix the login flow " }));
  });

  it("record → stop → uploads to /sessions/transcribe → trimmed transcript to the caller", async () => {
    const { onTranscript, onDictationError } = await renderButton();
    await dictate();
    expect(mockRecorder.prepareToRecordAsync).toHaveBeenCalled();
    expect(mockRecorder.record).toHaveBeenCalled();
    expect(mockRecorder.stop).toHaveBeenCalled();
    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith("fix the login flow"));
    expect(mockTranscribe).toHaveBeenCalledWith({
      uri: "file:///recordings/dictation.m4a",
      name: "dictation.m4a",
      ext: "m4a",
    });
    expect(onDictationError).not.toHaveBeenCalled();
    // Back to idle — the mic is ready for another take.
    expect(await screen.findByLabelText("Dictate")).toBeOnTheScreen();
  });

  it("503 (WHISPER_CMD unset on the host) → clear error, transcript never delivered", async () => {
    mockTranscribe.mockImplementation(async () => {
      throw new ApiError("http", 503);
    });
    const { onTranscript, onDictationError } = await renderButton();
    await dictate();
    await waitFor(() =>
      expect(onDictationError).toHaveBeenCalledWith("Dictation isn't set up on the mini — type it instead."),
    );
    expect(onTranscript).not.toHaveBeenCalled();
    expect(await screen.findByLabelText("Dictate")).toBeOnTheScreen();
  });

  it("unreachable server → generic error; no token → same path", async () => {
    mockTranscribe.mockImplementation(async () => {
      throw new ApiError("unreachable");
    });
    const first = await renderButton();
    await dictate();
    await waitFor(() =>
      expect(first.onDictationError).toHaveBeenCalledWith("Dictation didn't reach the mini — type it instead."),
    );

    getSessionsApiMock.mockImplementation(async () => null);
    const second = await renderButton();
    await dictate();
    await waitFor(() =>
      expect(second.onDictationError).toHaveBeenCalledWith("Dictation didn't reach the mini — type it instead."),
    );
    expect(second.onTranscript).not.toHaveBeenCalled();
  });

  it("empty transcript (silence) → 'nothing heard' error, input untouched", async () => {
    mockTranscribe.mockImplementation(async () => ({ text: "  " }));
    const { onTranscript, onDictationError } = await renderButton();
    await dictate();
    await waitFor(() =>
      expect(onDictationError).toHaveBeenCalledWith("Nothing heard — try again closer to the mic."),
    );
    expect(onTranscript).not.toHaveBeenCalled();
  });
});
