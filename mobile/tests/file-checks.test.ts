import { MAX_FILE_BYTES, checkCapturedFile } from "../src/lib/file-checks";

describe("checkCapturedFile", () => {
  it("accepts whitelisted extensions, normalized to lowercase", () => {
    expect(checkCapturedFile({ nameOrUri: "IMG_1.JPG" })).toEqual({ ok: true, ext: "jpg" });
    expect(checkCapturedFile({ nameOrUri: "a.jpeg" })).toEqual({ ok: true, ext: "jpeg" });
    expect(checkCapturedFile({ nameOrUri: "x.heic" })).toEqual({ ok: true, ext: "heic" });
    expect(checkCapturedFile({ nameOrUri: "file:///tmp/rec/voice.m4a" })).toEqual({
      ok: true,
      ext: "m4a",
    });
    expect(checkCapturedFile({ nameOrUri: "s.png" })).toEqual({ ok: true, ext: "png" });
    expect(checkCapturedFile({ nameOrUri: "t.mp3" })).toEqual({ ok: true, ext: "mp3" });
    expect(checkCapturedFile({ nameOrUri: "u.wav" })).toEqual({ ok: true, ext: "wav" });
  });

  it("rejects extensions outside the server whitelist", () => {
    expect(checkCapturedFile({ nameOrUri: "doc.pdf" })).toEqual({
      ok: false,
      reason: "Unsupported file type: pdf",
    });
    expect(checkCapturedFile({ nameOrUri: "noext" })).toEqual({
      ok: false,
      reason: "Unsupported file type: (none)",
    });
  });

  it("rejects files over the 25 MB server cap", () => {
    expect(checkCapturedFile({ nameOrUri: "big.jpg", sizeBytes: MAX_FILE_BYTES + 1 })).toEqual({
      ok: false,
      reason: "File too large (max 25 MB)",
    });
    expect(checkCapturedFile({ nameOrUri: "ok.jpg", sizeBytes: MAX_FILE_BYTES })).toEqual({
      ok: true,
      ext: "jpg",
    });
  });

  it("allows unknown size (server still enforces its cap)", () => {
    expect(checkCapturedFile({ nameOrUri: "v.m4a" })).toEqual({ ok: true, ext: "m4a" });
  });
});
