import { fireEvent, render, screen } from "@testing-library/react-native";
import { Alert } from "react-native";

import ActScreen from "../src/app/(tabs)/act";
import { getApi } from "../src/lib/brain";
import { ThemeProvider } from "../src/theme";

const answerQuestion = jest.fn(async () => ({ ok: true }));
const approvePr = jest.fn(async () => ({ ok: true }));

jest.mock("../src/lib/brain", () => ({
  getApi: jest.fn(),
}));

const getApiMock = getApi as jest.Mock;

function apiWith(overrides: Record<string, unknown> = {}) {
  return {
    listQuestions: async () => [
      {
        id: "2026-07-09-red-note",
        title: 'Is the red note "rotate quarterly"?',
        body: "I can read the diagram but not the red margin note.",
        date: "2026-07-09",
      },
    ],
    listApprovals: async () => [
      {
        number: 30,
        title: "Fix stale spec status",
        branch: "loop/stale-status",
        url: "https://github.com/x",
        verdict: "VERDICT: PASS — scoped and correct",
      },
    ],
    fleet: async () => ({ loopDisabled: false, lastReport: "2026-07-09-richsmon.md" }),
    listCloudApprovals: async () => [],
    cloudApprove: jest.fn(async () => ({ ok: true })),
    keepLocal: jest.fn(async () => ({ ok: true })),
    answerQuestion,
    approvePr,
    rejectPr: jest.fn(async () => ({ ok: true })),
    ...overrides,
  };
}

function renderAct() {
  return render(
    <ThemeProvider systemScheme="dark">
      <ActScreen />
    </ThemeProvider>,
  );
}

describe("ActScreen", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    answerQuestion.mockClear();
    approvePr.mockClear();
    getApiMock.mockResolvedValue(apiWith());
  });

  it("shows the fleet line, approvals with verdicts, and open questions", async () => {
    await renderAct();
    expect(await screen.findByText(/loops live/)).toBeOnTheScreen();
    expect(screen.getByText("Fix stale spec status")).toBeOnTheScreen();
    expect(screen.getByText(/VERDICT: PASS/)).toBeOnTheScreen();
    expect(screen.getByText('Is the red note "rotate quarterly"?')).toBeOnTheScreen();
  });

  it("answers a question with typed text", async () => {
    await renderAct();
    const input = await screen.findByPlaceholderText("Answer…");
    await fireEvent.changeText(input, "It says rotate quarterly.");
    await fireEvent.press(screen.getByText("Send answer"));
    expect(answerQuestion).toHaveBeenCalledWith("2026-07-09-red-note", "It says rotate quarterly.");
  });

  it("approve asks for confirmation before merging", async () => {
    jest.spyOn(Alert, "alert").mockImplementation((_t, _m, buttons) => {
      buttons?.find((b) => b.text === "Merge")?.onPress?.();
    });
    await renderAct();
    await fireEvent.press(await screen.findByText("Approve"));
    expect(Alert.alert).toHaveBeenCalled();
    expect(approvePr).toHaveBeenCalledWith(30);
  });

  it("stays honest when there is nothing to act on", async () => {
    getApiMock.mockResolvedValue(
      apiWith({ listQuestions: async () => [], listApprovals: async () => [] }),
    );
    await renderAct();
    expect(
      await screen.findByText("Nothing needs you. I'll ask when something does."),
    ).toBeOnTheScreen();
  });
});

describe("cloud approvals in Act", () => {
  it("shows the pending card and approves cloud analysis", async () => {
    const cloudApprove = jest.fn(async () => ({ ok: true }));
    getApiMock.mockResolvedValue(
      apiWith({
        listQuestions: async () => [],
        listApprovals: async () => [],
        listCloudApprovals: async () => [
          { id: "2026-07-10-abc", title: "Nejasná vec", reason: "confidence 0.4 < 0.6" },
        ],
        cloudApprove,
        keepLocal: jest.fn(async () => ({ ok: true })),
      }),
    );
    await renderAct();
    expect(await screen.findByText("Nejasná vec")).toBeOnTheScreen();
    await fireEvent.press(screen.getByText("Ask @claude"));
    expect(cloudApprove).toHaveBeenCalledWith("2026-07-10-abc");
  });
});
