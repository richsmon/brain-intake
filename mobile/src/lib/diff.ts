// BI-C2: minimal unified-diff rendering for Edit/Write gate cards — no diff
// library. Good enough for phone review: common prefix/suffix lines collapse
// to a little context, the changed middle shows as -/+ lines.

export interface DiffLine {
  kind: "ctx" | "del" | "add";
  text: string;
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  return text.split("\n");
}

/** Prefix/suffix line diff: context around a single changed middle block. */
export function computeDiff(oldText: string, newText: string, context = 2): DiffLine[] {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);

  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const out: DiffLine[] = [];
  for (const line of oldLines.slice(Math.max(0, prefix - context), prefix)) {
    out.push({ kind: "ctx", text: line });
  }
  for (const line of oldLines.slice(prefix, oldLines.length - suffix)) {
    out.push({ kind: "del", text: line });
  }
  for (const line of newLines.slice(prefix, newLines.length - suffix)) {
    out.push({ kind: "add", text: line });
  }
  const suffixStart = oldLines.length - suffix;
  for (const line of oldLines.slice(suffixStart, Math.min(oldLines.length, suffixStart + context))) {
    out.push({ kind: "ctx", text: line });
  }
  return out;
}

export interface DiffStat {
  added: number;
  removed: number;
}

export function diffStat(lines: DiffLine[]): DiffStat {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "add") added += 1;
    else if (line.kind === "del") removed += 1;
  }
  return { added, removed };
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "str_replace_based_edit_tool"]);

export function isEditTool(toolName: string): boolean {
  return EDIT_TOOLS.has(toolName);
}

/** Diff lines for an Edit/Write tool input; null when the tool isn't an edit
 *  or the input carries no usable strings. */
export function diffForTool(toolName: string, input: Record<string, unknown>): DiffLine[] | null {
  if (!isEditTool(toolName)) return null;
  const oldStr = typeof input.old_string === "string" ? input.old_string : "";
  const newStr = typeof input.new_string === "string" ? input.new_string : "";
  if (oldStr !== "" || newStr !== "") return computeDiff(oldStr, newStr);
  // Write / create: the whole content is an addition.
  const content = typeof input.content === "string" ? input.content : typeof input.file_text === "string" ? input.file_text : "";
  if (content !== "") return computeDiff("", content);
  return null;
}

export function toolFilePath(input: Record<string, unknown>): string | undefined {
  const path = input.file_path ?? input.path;
  return typeof path === "string" ? path : undefined;
}
