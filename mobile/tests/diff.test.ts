import { computeDiff, diffForTool, diffStat, isEditTool, toolFilePath } from "../src/lib/diff";

describe("computeDiff", () => {
  it("marks removed and added lines with surrounding context", () => {
    const oldText = "a\nb\nc\nd\ne";
    const newText = "a\nb\nC!\nd\ne";
    expect(computeDiff(oldText, newText)).toEqual([
      { kind: "ctx", text: "a" },
      { kind: "ctx", text: "b" },
      { kind: "del", text: "c" },
      { kind: "add", text: "C!" },
      { kind: "ctx", text: "d" },
      { kind: "ctx", text: "e" },
    ]);
  });

  it("pure addition (Write): every line is an add, no context", () => {
    expect(computeDiff("", "one\ntwo")).toEqual([
      { kind: "add", text: "one" },
      { kind: "add", text: "two" },
    ]);
  });

  it("identical texts produce trailing context only, no +/- lines", () => {
    const lines = computeDiff("same\nlines", "same\nlines");
    expect(lines.every((l) => l.kind === "ctx")).toBe(true);
  });

  it("diffStat counts adds and dels", () => {
    expect(diffStat(computeDiff("a\nb", "a\nx\ny"))).toEqual({ added: 2, removed: 1 });
  });
});

describe("diffForTool", () => {
  it("Edit input diffs old_string vs new_string", () => {
    const lines = diffForTool("Edit", { old_string: "foo", new_string: "bar" });
    expect(lines).toEqual([
      { kind: "del", text: "foo" },
      { kind: "add", text: "bar" },
    ]);
  });

  it("Write input renders the content as additions", () => {
    expect(diffForTool("Write", { content: "hello" })).toEqual([{ kind: "add", text: "hello" }]);
  });

  it("non-edit tools return null", () => {
    expect(diffForTool("Bash", { command: "rm -rf /" })).toBeNull();
    expect(isEditTool("Bash")).toBe(false);
    expect(isEditTool("Write")).toBe(true);
  });

  it("toolFilePath reads file_path or path", () => {
    expect(toolFilePath({ file_path: "/a/b.ts" })).toBe("/a/b.ts");
    expect(toolFilePath({ path: "/c.ts" })).toBe("/c.ts");
    expect(toolFilePath({})).toBeUndefined();
  });
});
