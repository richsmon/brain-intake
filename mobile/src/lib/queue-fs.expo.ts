// QueueFs adapter over expo-file-system's File/Directory API. Thin by design —
// all queue logic lives (and is tested) in queue.ts; this file is only proven
// on-device (BI-17 acceptance run).

import { Directory, File } from "expo-file-system";

import type { QueueFs } from "./queue";

export const expoQueueFs: QueueFs = {
  async ensureDir(path) {
    new Directory(path).create({ intermediates: true, idempotent: true });
  },
  async writeText(path, content) {
    new File(path).write(content);
  },
  async readText(path) {
    return new File(path).text();
  },
  async copy(src, dest) {
    await new File(src).copy(new File(dest));
  },
  async listDirs(path) {
    return new Directory(path)
      .list()
      .filter((entry): entry is Directory => entry instanceof Directory)
      .map((dir) => dir.name);
  },
  async remove(path) {
    new Directory(path).delete();
  },
  async exists(path) {
    return new Directory(path).exists;
  },
};
