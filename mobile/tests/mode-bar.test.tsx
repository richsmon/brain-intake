import { fireEvent, render, screen } from "@testing-library/react-native";

import { ModeBar } from "../src/components/ds/mode-bar";
import { ThemeProvider } from "../src/theme";

async function renderBar(props: Partial<Parameters<typeof ModeBar>[0]> = {}) {
  const onChange = jest.fn();
  const utils = await render(
    <ThemeProvider systemScheme="dark">
      <ModeBar active="capture" onChange={onChange} {...props} />
    </ThemeProvider>,
  );
  return { onChange, ...utils };
}

describe("ModeBar", () => {
  it("renders the three modes — Read · Capture · Act", async () => {
    await renderBar();
    screen.getByText("Read");
    screen.getByText("Capture");
    screen.getByText("Act");
  });

  it("switches modes on press", async () => {
    const { onChange } = await renderBar();
    await fireEvent.press(screen.getByText("Read"));
    expect(onChange).toHaveBeenCalledWith("read");
    await fireEvent.press(screen.getByText("Act"));
    expect(onChange).toHaveBeenCalledWith("act");
  });

  it("shows badges only when counts are positive", async () => {
    await renderBar({ readBadge: 2, actBadge: 0 });
    screen.getByText("2");
    expect(screen.queryByText("0")).toBeNull();
  });
});
