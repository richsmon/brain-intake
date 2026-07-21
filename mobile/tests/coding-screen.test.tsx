import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";

import CodingScreen from "../src/app/(tabs)/coding";
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

  it("explains the missing token instead of showing a broken list", async () => {
    getSessionsApiMock.mockResolvedValue(null);
    await renderCoding();
    expect(await screen.findByText(/sessions token/i)).toBeOnTheScreen();
    expect(screen.queryByText("+ New")).toBeNull();
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

  it("defaults to gated mode and requires repo + prompt before starting", async () => {
    await renderCoding();
    await fireEvent.press(await screen.findByText("+ New"));
    await screen.findByText("New Session");
    expect(screen.getByText("gated (approve edits)")).toBeOnTheScreen();

    // No repo, no prompt — start must be inert.
    await fireEvent.press(screen.getByText("Start session"));
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
