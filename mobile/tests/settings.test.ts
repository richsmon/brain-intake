import { DEFAULT_BASE_URL, makeSettings, type SettingsStore } from "../src/lib/settings";

function memoryStore(): SettingsStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async getItem(key) {
      return data.get(key) ?? null;
    },
    async setItem(key, value) {
      data.set(key, value);
    },
  };
}

describe("makeSettings", () => {
  it("returns the tailnet default when nothing is stored", async () => {
    const settings = makeSettings(memoryStore());
    expect(await settings.getBaseUrl()).toBe(DEFAULT_BASE_URL);
    expect(DEFAULT_BASE_URL).toBe("http://100.96.207.63:8787");
  });

  it("round-trips a stored base URL", async () => {
    const settings = makeSettings(memoryStore());
    await settings.setBaseUrl("http://other-host:9999");
    expect(await settings.getBaseUrl()).toBe("http://other-host:9999");
  });

  it("trims whitespace on save", async () => {
    const settings = makeSettings(memoryStore());
    await settings.setBaseUrl("  http://h:1 \n");
    expect(await settings.getBaseUrl()).toBe("http://h:1");
  });
});
