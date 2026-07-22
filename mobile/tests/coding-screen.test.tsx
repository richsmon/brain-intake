import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";

import CodingScreen from "../src/app/(tabs)/coding";
import { ApiError } from "../src/lib/api";
import { getSessionsApi } from "../src/lib/brain";
import { ThemeProvider } from "../src/theme";

const mockPush = jest.fn();

jest.mock("expo-router", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react") as typeof import("react");
  return {
    router: { push: (...args: unknown[]) => mockPush(...args) },
    // Run the focus effect like a mount effect — good enough for screen tests.
    useFocusEffect: (cb: () => void | (() => void)) => {
      React.useEffect(cb, [cb]);
    },
  };
});

const mockCreate = jest.fn(async () => ({ id: "2026-07-22-new1" }));
const mockTranscribe = jest.fn(async () => ({ text: "dictated words" }));

// BI-C8: local-runs usage totals behind the Coding tab's usage card.
const usageTotals = (runs: number, input: number, output: number, cost: number) => ({
  runs,
  input_tokens: input,
  output_tokens: output,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  total_cost_usd: cost,
});
const mockUsageSummary = jest.fn(async () => ({
  today: usageTotals(2, 12_000, 345, 0.43),
  last7d: usageTotals(9, 2_000_000, 400_000, 12.5),
  thisMonth: usageTotals(21, 8_000_000, 950, 40),
}));

// BI-C6: the sheet embeds DictationButton, which records via expo-audio.
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

const mockFakeApi = {
  list: async () => [
    {
      id: "2026-07-22-aaaa1111",
      state: "running",
      createdAt: "2026-07-22T10:00:00Z",
      lastEvent: "chat_chunk",
      repo: "gotam",
      repoPath: "/x",
      prompt: "fix the login flow",
      model: "claude-sonnet-5",
      permissionMode: "gated",
    },
    {
      id: "2026-07-22-bbbb2222",
      state: "waiting-approval",
      createdAt: "2026-07-22T11:00:00Z",
      lastEvent: "permission_request",
      repo: "brain-intake",
      repoPath: "/y",
      prompt: "add the digest endpoint",
      model: "claude-opus-4-8",
      permissionMode: "gated",
    },
  ],
  meta: async () => ({
    repos: ["gotam", "brain-intake"],
    models: [
      { id: "claude-fable-5", label: "Fable" },
      { id: "claude-opus-4-8", label: "Opus" },
      { id: "claude-sonnet-5", label: "Sonnet" },
      { id: "claude-haiku-4-5", label: "Haiku" },
    ],
    efforts: ["low", "medium", "high", "xhigh", "max"],
  }),
  create: mockCreate,
  transcribe: mockTranscribe,
  usageSummary: mockUsageSummary,
};

jest.mock("../src/lib/brain", () => ({
  getSessionsApi: jest.fn(async () => mockFakeApi),
}));

const getSessionsApiMock = getSessionsApi as jest.Mock;

function renderCoding() {
  return render(
    <ThemeProvider systemScheme="dark">
      <CodingScreen />
    </ThemeProvider>,
  );
}

describe("CodingScreen", () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockCreate.mockClear();
    mockTranscribe.mockClear();
    mockUsageSummary.mockClear();
    getSessionsApiMock.mockResolvedValue(mockFakeApi);
  });

  it("lists sessions newest-first with state chips and opens the detail on tap", async () => {
    await renderCoding();
    expect(await screen.findByText("fix the login flow")).toBeOnTheScreen();
    expect(screen.getByText("add the digest endpoint")).toBeOnTheScreen();
    expect(screen.getByText("running")).toBeOnTheScreen();
    expect(screen.getByText("waiting")).toBeOnTheScreen();

    await fireEvent.press(screen.getByText("fix the login flow"));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/session/[id]",
      params: { id: "2026-07-22-aaaa1111" },
    });
  });

  it("renders the local-runs usage card above the list (BI-C8)", async () => {
    await renderCoding();
    expect(await screen.findByText("local runs · not plan limits")).toBeOnTheScreen();
    expect(screen.getByText("today")).toBeOnTheScreen();
    expect(screen.getByText("7 days")).toBeOnTheScreen();
    expect(screen.getByText("month")).toBeOnTheScreen();
    expect(screen.getByText("12.3k tok")).toBeOnTheScreen();
    expect(screen.getByText("$0.43")).toBeOnTheScreen();
    expect(screen.getByText("$12.50")).toBeOnTheScreen();
    // The session list still renders below the card.
    expect(screen.getByText("fix the login flow")).toBeOnTheScreen();
  });

  it("hides the usage card when the server has no /usage/summary (BI-C8)", async () => {
    mockUsageSummary.mockRejectedValueOnce(new ApiError("http", 404));
    await renderCoding();
    expect(await screen.findByText("fix the login flow")).toBeOnTheScreen();
    expect(screen.queryByText("local runs · not plan limits")).toBeNull();
  });

  it("explains the missing token instead of showing a broken list", async () => {
    getSessionsApiMock.mockResolvedValue(null);
    await renderCoding();
    expect(await screen.findByText(/sessions token/i)).toBeOnTheScreen();
    expect(screen.queryByText("+ New")).toBeNull();
    expect(screen.queryByText("Reviews")).toBeNull();
  });

  it("opens the review surface from the header (MC-R1)", async () => {
    await renderCoding();
    await fireEvent.press(await screen.findByText("Reviews"));
    expect(mockPush).toHaveBeenCalledWith("/reviews");
  });

  it("creates a session from the sheet with repo, model, effort and mode picked", async () => {
    await renderCoding();
    await fireEvent.press(await screen.findByText("+ New"));
    expect(await screen.findByText("New Session")).toBeOnTheScreen();

    // Picker values come from GET /sessions/meta. "gotam" also appears in the
    // session list behind the sheet — the sheet's chip renders last.
    const repoChips = screen.getAllByText("gotam");
    await fireEvent.press(repoChips[repoChips.length - 1]);
    await fireEvent.changeText(
      screen.getByPlaceholderText("What should the agent do?"),
      "ship the thing",
    );
    await fireEvent.press(screen.getByText("Sonnet"));
    await fireEvent.press(screen.getByText("xhigh"));
    await fireEvent.press(screen.getByText("Start session"));

    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    expect(mockCreate).toHaveBeenCalledWith({
      repo: "gotam",
      prompt: "ship the thing",
      model: "claude-sonnet-5",
      permissionMode: "gated",
      effort: "xhigh",
    });
    // Straight into the fresh session.
    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/session/[id]",
      params: { id: "2026-07-22-new1" },
    });
  });

  it("creates an auto-mode session when the third mode chip is picked (BI-C4)", async () => {
    await renderCoding();
    await fireEvent.press(await screen.findByText("+ New"));
    await screen.findByText("New Session");

    const repoChips = screen.getAllByText("gotam");
    await fireEvent.press(repoChips[repoChips.length - 1]);
    await fireEvent.changeText(
      screen.getByPlaceholderText("What should the agent do?"),
      "refactor without asking",
    );
    await fireEvent.press(screen.getByText("auto (no gates)"));
    await fireEvent.press(screen.getByText("Start session"));

    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    expect(mockCreate).toHaveBeenCalledWith({
      repo: "gotam",
      prompt: "refactor without asking",
      model: "claude-fable-5",
      permissionMode: "auto",
    });
  });

  it("dictates into the prompt: mic → stop → transcript appended, still editable (BI-C6)", async () => {
    await renderCoding();
    await fireEvent.press(await screen.findByText("+ New"));
    await screen.findByText("New Session");

    const promptInput = screen.getByPlaceholderText("What should the agent do?");
    await fireEvent.changeText(promptInput, "First part.");
    await fireEvent.press(screen.getByLabelText("Dictate"));
    await fireEvent.press(await screen.findByLabelText("Stop dictation"));
    await waitFor(() => expect(mockTranscribe).toHaveBeenCalled());
    // Transcript appends to the typed text in the same editable field.
    await waitFor(() => expect(promptInput.props.value).toBe("First part. dictated words"));
  });

  it("shows the dictation failure inline and leaves the typed prompt untouched (BI-C6)", async () => {
    mockTranscribe.mockRejectedValueOnce(new ApiError("http", 503));
    await renderCoding();
    await fireEvent.press(await screen.findByText("+ New"));
    await screen.findByText("New Session");

    const promptInput = screen.getByPlaceholderText("What should the agent do?");
    await fireEvent.changeText(promptInput, "typed by hand");
    await fireEvent.press(screen.getByLabelText("Dictate"));
    await fireEvent.press(await screen.findByLabelText("Stop dictation"));
    expect(await screen.findByText("Dictation isn't set up on the mini — type it instead.")).toBeOnTheScreen();
    expect(promptInput.props.value).toBe("typed by hand");
  });

  it("defaults to gated mode and requires repo + prompt before starting", async () => {
    await renderCoding();
    await fireEvent.press(await screen.findByText("+ New"));
    await screen.findByText("New Session");
    expect(screen.getByText("gated (approve edits)")).toBeOnTheScreen();
    // All three modes are on offer; gated stays the default.
    expect(screen.getByText("acceptEdits")).toBeOnTheScreen();
    expect(screen.getByText("auto (no gates)")).toBeOnTheScreen();

    // No repo, no prompt — start must be inert.
    await fireEvent.press(screen.getByText("Start session"));
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
