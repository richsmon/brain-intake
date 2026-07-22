import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";

import SessionDetailScreen, { deriveSession } from "../src/app/session/[id]";
import { getSessionsApi } from "../src/lib/brain";
import type { SessionEvent } from "../src/lib/sessions";
import { ThemeProvider } from "../src/theme";

jest.mock("expo-router", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react") as typeof import("react");
  return {
    useLocalSearchParams: () => ({ id: "2026-07-22-abcd1234" }),
    useFocusEffect: (cb: () => void | (() => void)) => {
      React.useEffect(cb, [cb]);
    },
  };
});

// BI-C6: the sticky message bar embeds DictationButton, which records via expo-audio.
jest.mock("expo-audio", () => ({
  RecordingPresets: { HIGH_QUALITY: {} },
  requestRecordingPermissionsAsync: jest.fn(async () => ({ granted: true })),
  useAudioRecorder: () => ({
    record: jest.fn(),
    stop: jest.fn(async () => undefined),
    prepareToRecordAsync: jest.fn(async () => undefined),
    uri: "file:///recordings/dictation.m4a",
    currentTime: 0,
  }),
}));

const mockApprove = jest.fn(async () => ({ ok: true }));
const mockDeny = jest.fn(async () => ({ ok: true }));
const mockSetMode = jest.fn(async () => ({ ok: true }));
const mockSendMessage = jest.fn(async () => ({ ok: true }));
let mockEvents: SessionEvent[] = [];
let mockState = "running";

jest.mock("../src/lib/brain", () => ({
  getSessionsApi: jest.fn(async () => ({
    events: async (_id: string, offset: number) => ({
      events: mockEvents.filter((e) => e.index >= offset),
      nextOffset: mockEvents.length,
      state: mockState,
    }),
    approve: mockApprove,
    deny: mockDeny,
    setMode: mockSetMode,
    sendMessage: mockSendMessage,
  })),
}));

const created: SessionEvent = {
  index: 0,
  event: "status",
  status: "created",
  repo: "gotam",
  repoPath: "/x",
  prompt: "fix login",
  model: "claude-sonnet-5",
  permissionMode: "gated",
};

function renderDetail() {
  return render(
    <ThemeProvider systemScheme="dark">
      <SessionDetailScreen />
    </ThemeProvider>,
  );
}

describe("SessionDetailScreen", () => {
  beforeEach(() => {
    (getSessionsApi as jest.Mock).mockClear();
    mockApprove.mockClear();
    mockDeny.mockClear();
    mockSetMode.mockClear();
    mockSendMessage.mockClear();
  });

  it("renders chat, the Edit diff gate card and a sticky Approve/Deny bar on waiting-approval", async () => {
    mockState = "waiting-approval";
    mockEvents = [
      created,
      { index: 1, event: "status", status: "running" },
      { index: 2, event: "chat_chunk", text: "I'll fix the login flow now." },
      {
        index: 3,
        event: "tool_call",
        requestId: "r1",
        toolName: "Edit",
        input: { file_path: "src/login.ts", old_string: "const x = 1;", new_string: "const x = 2;" },
      },
      {
        index: 4,
        event: "permission_request",
        requestId: "r1",
        toolName: "Edit",
        input: { file_path: "src/login.ts", old_string: "const x = 1;", new_string: "const x = 2;" },
        path: "src/login.ts",
      },
      { index: 5, event: "status", status: "waiting-approval" },
    ];

    await renderDetail();
    expect(await screen.findByText("I'll fix the login flow now.")).toBeOnTheScreen();
    // Unified diff with +/- lines, from old_string/new_string — no diff lib.
    expect(screen.getByText("const x = 1;")).toBeOnTheScreen();
    expect(screen.getByText("const x = 2;")).toBeOnTheScreen();
    expect(screen.getByText("needs approval")).toBeOnTheScreen();
    expect(screen.getByText("waiting")).toBeOnTheScreen();

    await fireEvent.press(screen.getByText("Approve"));
    await waitFor(() => expect(mockApprove).toHaveBeenCalledWith("2026-07-22-abcd1234", "r1"));
  });

  it("Deny routes to the deny endpoint with the pending requestId", async () => {
    mockState = "waiting-approval";
    mockEvents = [
      created,
      {
        index: 1,
        event: "permission_request",
        requestId: "r9",
        toolName: "Bash",
        input: { command: "rm -rf build" },
        command: "rm -rf build",
      },
      { index: 2, event: "status", status: "waiting-approval" },
    ];
    await renderDetail();
    // Bash gates render the command, not a diff.
    expect(await screen.findByText("$ rm -rf build")).toBeOnTheScreen();
    await fireEvent.press(screen.getByText("Deny"));
    await waitFor(() => expect(mockDeny).toHaveBeenCalledWith("2026-07-22-abcd1234", "r9"));
  });

  it("allowlisted Bash renders as a command card and follow-up messages reach the agent", async () => {
    mockState = "running";
    mockEvents = [
      created,
      { index: 1, event: "status", status: "running" },
      { index: 2, event: "tool_call", requestId: "t1", toolName: "Bash", input: { command: "git status" } },
    ];
    await renderDetail();
    expect(await screen.findByText("$ git status")).toBeOnTheScreen();

    const inputBox = screen.getByPlaceholderText("Message the agent…");
    await fireEvent.changeText(inputBox, "also run the tests");
    await fireEvent.press(screen.getByText("Send"));
    await waitFor(() =>
      expect(mockSendMessage).toHaveBeenCalledWith("2026-07-22-abcd1234", "also run the tests"),
    );
  });

  it("mode switch calls the mode endpoint", async () => {
    mockState = "running";
    mockEvents = [created, { index: 1, event: "status", status: "running" }];
    await renderDetail();
    await screen.findByText("gated");
    await fireEvent.press(screen.getByText("acceptEdits"));
    await waitFor(() =>
      expect(mockSetMode).toHaveBeenCalledWith("2026-07-22-abcd1234", "acceptEdits"),
    );
  });

  it("mode switch offers auto and flips a running session to it (BI-C4)", async () => {
    mockState = "running";
    mockEvents = [created, { index: 1, event: "status", status: "running" }];
    await renderDetail();
    await screen.findByText("gated");
    await fireEvent.press(screen.getByText("auto"));
    await waitFor(() =>
      expect(mockSetMode).toHaveBeenCalledWith("2026-07-22-abcd1234", "auto"),
    );
  });

  it("done sessions show the final summary and the per-file diff stat; no input bar", async () => {
    mockState = "done";
    mockEvents = [
      created,
      { index: 1, event: "status", status: "running" },
      {
        index: 2,
        event: "tool_call",
        requestId: "r1",
        toolName: "Edit",
        input: { file_path: "src/login.ts", old_string: "a\nb", new_string: "a\nB\nc" },
      },
      { index: 3, event: "permission_request", requestId: "r1", toolName: "Edit", input: { file_path: "src/login.ts", old_string: "a\nb", new_string: "a\nB\nc" } },
      { index: 4, event: "permission_resolved", requestId: "r1", decision: "approved" },
      { index: 5, event: "result", outcome: "success", summary: "Login flow fixed and verified." },
      { index: 6, event: "status", status: "done" },
    ];
    await renderDetail();
    expect(await screen.findByText("Login flow fixed and verified.")).toBeOnTheScreen();
    expect(screen.getByText("✦ done")).toBeOnTheScreen();
    expect(screen.getByText("approved")).toBeOnTheScreen();
    // Per-file stat: src/login.ts +2 −1 (path also appears on the gate card head)
    expect(screen.getAllByText(/src\/login\.ts/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("+2")).toBeOnTheScreen();
    expect(screen.getByText("-1")).toBeOnTheScreen();
    expect(screen.queryByPlaceholderText("Message the agent…")).toBeNull();
    expect(screen.queryByText("Approve")).toBeNull();
  });

  it("done summary renders per-run tokens and cost from the result event (BI-C5)", async () => {
    mockState = "done";
    mockEvents = [
      created,
      { index: 1, event: "status", status: "running" },
      {
        index: 2,
        event: "result",
        outcome: "success",
        summary: "All wired up.",
        usage: { input_tokens: 1200, output_tokens: 340, cache_creation_input_tokens: 5000, cache_read_input_tokens: 88000 },
        total_cost_usd: 0.4321,
      },
      { index: 3, event: "status", status: "done" },
    ];
    await renderDetail();
    expect(await screen.findByText("All wired up.")).toBeOnTheScreen();
    expect(screen.getByText("1.2k in · 340 out · 88k cached · $0.43")).toBeOnTheScreen();
  });

  it("a result without usage renders no token line (BI-C5)", async () => {
    mockState = "done";
    mockEvents = [
      created,
      { index: 1, event: "status", status: "running" },
      { index: 2, event: "result", outcome: "success", summary: "Done without telemetry." },
      { index: 3, event: "status", status: "done" },
    ];
    await renderDetail();
    expect(await screen.findByText("Done without telemetry.")).toBeOnTheScreen();
    expect(screen.queryByText(/ in · /)).toBeNull();
  });
});

describe("deriveSession", () => {
  it("denied edits are excluded from the diff stat and gates fold their resolution", () => {
    const derived = deriveSession([
      created,
      { index: 1, event: "status", status: "running" },
      {
        index: 2,
        event: "tool_call",
        requestId: "r1",
        toolName: "Edit",
        input: { file_path: "a.ts", old_string: "x", new_string: "y" },
      },
      { index: 3, event: "permission_request", requestId: "r1", toolName: "Edit", input: { file_path: "a.ts", old_string: "x", new_string: "y" } },
      { index: 4, event: "permission_resolved", requestId: "r1", decision: "denied" },
      { index: 5, event: "status", status: "running" },
    ]);
    expect(derived.fileStats).toEqual([]);
    const gate = derived.items.find((i) => i.type === "gate");
    expect(gate).toMatchObject({ decision: "denied" });
    expect(derived.pending).toBeNull();
    // The gated tool_call collapses into the gate card — no duplicate tool card.
    expect(derived.items.filter((i) => i.type === "tool")).toHaveLength(0);
  });

  it("tracks auto mode from the created meta and from mode events (BI-C4)", () => {
    const startedAuto = deriveSession([
      { ...created, permissionMode: "auto" },
      { index: 1, event: "status", status: "running" },
    ]);
    expect(startedAuto.mode).toBe("auto");

    const flipped = deriveSession([
      created,
      { index: 1, event: "status", status: "running" },
      { index: 2, event: "mode", mode: "auto" },
    ]);
    expect(flipped.mode).toBe("auto");
    expect(flipped.items.some((i) => i.type === "sys" && i.text === "mode → auto")).toBe(true);
  });

  it("result items carry parsed usage + cost; malformed usage is dropped (BI-C5)", () => {
    const derived = deriveSession([
      created,
      { index: 1, event: "status", status: "running" },
      {
        index: 2,
        event: "result",
        outcome: "success",
        usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 1, cache_read_input_tokens: 2 },
        total_cost_usd: 0.05,
      },
      { index: 3, event: "status", status: "done" },
    ]);
    const result = derived.items.find((i) => i.type === "result");
    expect(result).toMatchObject({
      usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 1, cache_read_input_tokens: 2 },
      totalCostUsd: 0.05,
    });

    const malformed = deriveSession([
      created,
      { index: 1, event: "result", outcome: "success", usage: { input_tokens: "lots" } },
    ]);
    const bare = malformed.items.find((i) => i.type === "result");
    expect(bare).toBeDefined();
    expect(bare && "usage" in bare).toBe(false);
  });

  it("pending stays null unless the session is actually waiting", () => {
    const derived = deriveSession([
      created,
      { index: 1, event: "permission_request", requestId: "r1", toolName: "Edit", input: {} },
      { index: 2, event: "status", status: "waiting-approval" },
    ]);
    expect(derived.pending).toEqual({ requestId: "r1", toolName: "Edit" });
    expect(derived.state).toBe("waiting-approval");
  });
});
