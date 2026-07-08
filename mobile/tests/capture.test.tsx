import { fireEvent, render, screen } from "@testing-library/react-native";

import CaptureScreen from "../src/app/(tabs)/index";
import { captureText } from "../src/lib/brain";

jest.mock("../src/lib/brain", () => ({
  captureText: jest.fn(async () => undefined),
}));

const captureTextMock = captureText as jest.Mock;

describe("CaptureScreen", () => {
  beforeEach(() => captureTextMock.mockClear());

  it("saves a trimmed text note and clears the input", async () => {
    await render(<CaptureScreen />);
    const input = screen.getByPlaceholderText("Text note…");
    await fireEvent.changeText(input, "  remember this  ");
    await fireEvent.press(screen.getByText("Save to brain"));
    await screen.findByText("Queued ✓");
    expect(captureTextMock).toHaveBeenCalledWith("remember this");
    expect(input.props.value).toBe("");
  });

  it("ignores empty input", async () => {
    await render(<CaptureScreen />);
    await fireEvent.press(screen.getByText("Save to brain"));
    expect(captureTextMock).not.toHaveBeenCalled();
  });
});
