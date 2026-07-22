import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Alert } from "react-native";

import ReviewsScreen from "../src/app/reviews";
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

const mockLaunchReview = jest.fn(async () => ({ sessionId: "2026-07-22-rev1" }));

const mockFakeApi = {
  reviewPrs: async () => [
    {
      repo: "platform",
      number: 94,
      title: "Harden dashboard aggregation",
      author: "palo-kunovsky",
      branch: "MC-74/dashboard-aggregation-hardening",
      updatedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      additions: 1534,
      deletions: 34,
    },
    {
      repo: "app",
      number: 90,
      title: "Add login flow",
      author: "ArsenLabovich",
      branch: "login-pages",
      updatedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      additions: 7390,
      deletions: 2155,
    },
  ],
  meta: async () => ({
    repos: [],
    models: [
      { id: "claude-fable-5", label: "Fable" },
      { id: "claude-opus-4-8", label: "Opus" },
      { id: "claude-sonnet-5", label: "Sonnet" },
    ],
    efforts: ["low", "medium", "high", "xhigh", "max"],
  }),
  launchReview: mockLaunchReview,
};

jest.mock("../src/lib/brain", () => ({
  getSessionsApi: jest.fn(async () => mockFakeApi),
}));

const getSessionsApiMock = getSessionsApi as jest.Mock;

function renderReviews() {
  return render(
    <ThemeProvider systemScheme="dark">
      <ReviewsScreen />
    </ThemeProvider>,
  );
}

describe("ReviewsScreen", () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockLaunchReview.mockClear();
    getSessionsApiMock.mockResolvedValue(mockFakeApi);
  });

  it("lists open PRs with repo, number, author, age and diff stats", async () => {
    await renderReviews();
    expect(await screen.findByText("Harden dashboard aggregation")).toBeOnTheScreen();
    expect(screen.getByText("platform #94")).toBeOnTheScreen();
    expect(screen.getByText("app #90")).toBeOnTheScreen();
    expect(screen.getByText("palo-kunovsky")).toBeOnTheScreen();
    expect(screen.getByText("+1534")).toBeOnTheScreen();
    expect(screen.getByText("-34")).toBeOnTheScreen();
    expect(screen.getByText("3h")).toBeOnTheScreen();
    expect(screen.getByText("2d")).toBeOnTheScreen();
  });

  it("explains the missing token instead of showing a broken list", async () => {
    getSessionsApiMock.mockResolvedValue(null);
    await renderReviews();
    expect(await screen.findByText(/sessions token/i)).toBeOnTheScreen();
  });

  it("tap PR → pick model + effort → launch → opens the session detail", async () => {
    await renderReviews();
    await fireEvent.press(await screen.findByText("Harden dashboard aggregation"));
    expect(await screen.findByText("Launch Review")).toBeOnTheScreen();

    await fireEvent.press(screen.getByText("Opus"));
    await fireEvent.press(screen.getByText("xhigh"));
    await fireEvent.press(screen.getByText("Launch review"));

    await waitFor(() => expect(mockLaunchReview).toHaveBeenCalled());
    expect(mockLaunchReview).toHaveBeenCalledWith({
      repo: "platform",
      pr: 94,
      model: "claude-opus-4-8",
      effort: "xhigh",
    });
    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/session/[id]",
      params: { id: "2026-07-22-rev1" },
    });
  });

  it("surfaces the server's no-local-checkout 409 as a clear alert", async () => {
    const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    mockLaunchReview.mockRejectedValueOnce(new ApiError("http", 409));

    await renderReviews();
    await fireEvent.press(await screen.findByText("Add login flow"));
    await screen.findByText("Launch Review");
    await fireEvent.press(screen.getByText("Launch review"));

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    expect(alertSpy.mock.calls[0][0]).toBe("No local checkout");
    expect(alertSpy.mock.calls[0][1]).toContain("app");
    expect(mockPush).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });
});
