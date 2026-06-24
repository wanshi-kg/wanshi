import { EventEmitter } from "events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Mock child_process.spawn so the C2PA tests drive synthetic c2patool output
// (exit code + stdout/stderr) without shelling a real binary.
const mockSpawn = jest.fn();
jest.mock("child_process", () => ({ spawn: (...a: any[]) => mockSpawn(...a) }));

import { readExif, readC2pa, formatExifDateTaken } from "./imageMetadata";
import { stubLogger } from "../../../../__tests__/helpers";

/** A fake c2patool: emits `stdout`/`stderr`, then closes with `code`. */
const fakeC2patool = (stdout: string, stderr: string, code: number) => () => {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  setImmediate(() => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    child.emit("close", code);
  });
  return child;
};

beforeEach(() => mockSpawn.mockReset());

describe("readExif", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kgexif-"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("returns undefined (no throw) for a file with no parseable EXIF", async () => {
    const p = path.join(tmp, "not-an-image.txt");
    fs.writeFileSync(p, "plain text, definitely not a JPEG with EXIF");
    await expect(readExif(p, stubLogger())).resolves.toBeUndefined();
  });

  it("returns undefined (no throw) for a missing file", async () => {
    await expect(readExif(path.join(tmp, "ghost.jpg"), stubLogger())).resolves.toBeUndefined();
  });
});

// WS-20: EXIF capture time must not round-trip a local-time Date through
// toISOString() (which shifts by the host UTC offset and falsely labels UTC).
describe("formatExifDateTaken (WS-20)", () => {
  it("anchors the offset from OffsetTimeOriginal instead of shifting the clock", () => {
    // A photo taken at 10:30 local in UTC+2 stays 10:30, now zone-anchored.
    expect(formatExifDateTaken("2026:06:19 10:30:00", "+02:00")).toBe("2026-06-19T10:30:00+02:00");
  });

  it("keeps a floating local time (no Z) when no offset tag is present", () => {
    const out = formatExifDateTaken("2026:06:19 10:30:00");
    expect(out).toBe("2026-06-19T10:30:00");
    expect(out).not.toMatch(/Z$/); // never fabricates UTC
    expect(out).not.toMatch(/[+-]\d{2}:\d{2}$/); // and never fabricates an offset
  });

  it("renders a Date as local wall-clock without a UTC round-trip", () => {
    // Build a Date at a known LOCAL wall-clock; the output must echo that clock,
    // regardless of the host zone — unlike toISOString() which would shift it.
    const d = new Date(2026, 5, 19, 10, 30, 0); // local 2026-06-19 10:30:00
    expect(formatExifDateTaken(d)).toBe("2026-06-19T10:30:00");
  });

  it("ignores a malformed offset rather than appending garbage", () => {
    expect(formatExifDateTaken("2026:06:19 10:30:00", "bogus")).toBe("2026-06-19T10:30:00");
  });

  it("returns undefined for a nullish datetime", () => {
    expect(formatExifDateTaken(undefined)).toBeUndefined();
    expect(formatExifDateTaken(null)).toBeUndefined();
  });
});

describe("readC2pa", () => {
  let tmp: string;
  let p: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kgc2pa-"));
    p = path.join(tmp, "img.jpg");
    fs.writeFileSync(p, "not really an image");
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("reports unavailable (no throw) when the c2patool binary is missing", async () => {
    const res = await readC2pa(p, "kg-gen-no-such-c2patool-bin", stubLogger());
    expect(res.present).toBe(false);
    expect(res.unavailable).toBe(true);
  });

  it("reports a clean absent credential (present:false, not unavailable)", async () => {
    mockSpawn.mockImplementation(fakeC2patool("", "No claim found", 1));
    const res = await readC2pa(p, "c2patool", stubLogger());
    expect(res.present).toBe(false);
    expect(res.unavailable).toBeUndefined();
  });

  it("reads a clean valid manifest as present + valid", async () => {
    const report = JSON.stringify({
      active_manifest: "m1",
      manifests: { m1: { signature_info: { issuer: "Acme CA" } } },
      validation_status: [],
    });
    mockSpawn.mockImplementation(fakeC2patool(report, "", 0));
    const res = await readC2pa(p, "c2patool", stubLogger());
    expect(res).toMatchObject({ present: true, valid: true, signer: "Acme CA" });
  });

  // WS-05: real C2PA failure codes contain no /error|invalid|fail/ substring, so the
  // old check read tampered/untrusted manifests as valid (fail-open). They must be invalid.
  it("WS-05: marks a tampered/untrusted manifest INVALID despite benign-looking codes", async () => {
    const report = JSON.stringify({
      active_manifest: "m1",
      manifests: { m1: { signature_info: { issuer: "Self-Signed" } } },
      validation_status: [
        { code: "signingCredential.untrusted", url: "self#jumbf", success: false },
        { code: "assertion.dataHash.mismatch", url: "self#jumbf", success: false },
      ],
    });
    mockSpawn.mockImplementation(fakeC2patool(report, "", 0));
    const res = await readC2pa(p, "c2patool", stubLogger());
    expect(res.present).toBe(true);
    expect(res.valid).toBe(false);
  });

  it("WS-05: marks a code-only failure entry (no success flag) INVALID, fail-closed", async () => {
    const report = JSON.stringify({
      active_manifest: "m1",
      manifests: { m1: {} },
      validation_status: [{ code: "timeStamp.mismatch", url: "self#jumbf" }],
    });
    mockSpawn.mockImplementation(fakeC2patool(report, "", 0));
    const res = await readC2pa(p, "c2patool", stubLogger());
    expect(res.valid).toBe(false);
  });

  it("WS-05: honors an explicit validation_state of Invalid", async () => {
    const report = JSON.stringify({
      active_manifest: "m1",
      manifests: { m1: {} },
      validation_state: "Invalid",
      validation_status: [],
    });
    mockSpawn.mockImplementation(fakeC2patool(report, "", 0));
    const res = await readC2pa(p, "c2patool", stubLogger());
    expect(res.valid).toBe(false);
  });
});
