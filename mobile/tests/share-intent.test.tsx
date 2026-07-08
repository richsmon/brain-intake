import { render } from "@testing-library/react-native";

import ShareIntentHandler from "../src/components/share-intent-handler";
import { captureFile, captureText } from "../src/lib/brain";

jest.mock("../src/lib/brain", () => ({
  captureText: jest.fn(async () => undefined),
  captureFile: jest.fn(async () => ({ ok: true, ext: "jpg" })),
}));

const mockResetShareIntent = jest.fn();
let mockIntentState: { hasShareIntent: boolean; shareIntent: unknown };

jest.mock("expo-share-intent", () => ({
  useShareIntent: () => ({
    ...mockIntentState,
    resetShareIntent: mockResetShareIntent,
    error: null,
  }),
}));

const captureTextMock = captureText as jest.Mock;
const captureFileMock = captureFile as jest.Mock;

async function flushMicrotasks() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ShareIntentHandler", () => {
  beforeEach(() => {
    captureTextMock.mockClear();
    captureFileMock.mockClear();
    mockResetShareIntent.mockClear();
  });

  it("captures a shared web URL as share-sheet source and resets the intent", async () => {
    mockIntentState = {
      hasShareIntent: true,
      shareIntent: { webUrl: "https://example.com/post", text: null, files: null, type: "weburl" },
    };
    await render(<ShareIntentHandler />);
    await flushMicrotasks();
    expect(captureTextMock).toHaveBeenCalledWith("https://example.com/post", "share-sheet");
    expect(mockResetShareIntent).toHaveBeenCalled();
  });

  it("captures shared text when there is no URL", async () => {
    mockIntentState = {
      hasShareIntent: true,
      shareIntent: { webUrl: null, text: "quoted thought", files: null, type: "text" },
    };
    await render(<ShareIntentHandler />);
    await flushMicrotasks();
    expect(captureTextMock).toHaveBeenCalledWith("quoted thought", "share-sheet");
  });

  it("captures shared image files via captureFile", async () => {
    mockIntentState = {
      hasShareIntent: true,
      shareIntent: {
        webUrl: null,
        text: null,
        type: "media",
        files: [
          { path: "file:///shared/pic.jpg", fileName: "pic.jpg", mimeType: "image/jpeg", size: 500 },
        ],
      },
    };
    await render(<ShareIntentHandler />);
    await flushMicrotasks();
    expect(captureFileMock).toHaveBeenCalledWith({
      source: "photo",
      uri: "file:///shared/pic.jpg",
      name: "pic.jpg",
      sizeBytes: 500,
    });
    expect(mockResetShareIntent).toHaveBeenCalled();
  });

  it("does nothing without an intent", async () => {
    mockIntentState = { hasShareIntent: false, shareIntent: { webUrl: null, text: null, files: null, type: null } };
    await render(<ShareIntentHandler />);
    await flushMicrotasks();
    expect(captureTextMock).not.toHaveBeenCalled();
    expect(captureFileMock).not.toHaveBeenCalled();
    expect(mockResetShareIntent).not.toHaveBeenCalled();
  });
});
