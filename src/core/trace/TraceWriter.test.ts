import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { trace } from "./TraceWriter";
import { TRACE_VERSION, TraceRecord } from "./events";

describe("TraceWriter", () => {
  let tmp: string;
  let out: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kgtrace-"));
    out = path.join(tmp, "sub", "graph.json.trace.jsonl"); // nested → exercises dir-ensure
    trace.reset();
  });
  afterEach(() => {
    trace.reset();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const readRecords = (): TraceRecord[] =>
    fs
      .readFileSync(out, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));

  it("writes nothing when disabled (zero-overhead default)", () => {
    trace.configure({ enabled: false, path: out, runId: "r1" });
    expect(trace.enabled).toBe(false);
    trace.emit({ stage: "export", type: "export", format: "json", entities: 1, relations: 0 });
    expect(fs.existsSync(out)).toBe(false);
  });

  it("stays disabled when no path is given", () => {
    trace.configure({ enabled: true, path: undefined, runId: "r1" });
    expect(trace.enabled).toBe(false);
  });

  it("appends envelope-stamped JSONL when enabled, preserving order", () => {
    trace.configure({ enabled: true, path: out, runId: "run-abc" });
    trace.emit({ stage: "run", type: "run_start", output: "graph.json", resumed: false });
    trace.emit({ stage: "export", type: "export", format: "json", entities: 3, relations: 2 });

    const recs = readRecords();
    expect(recs).toHaveLength(2);
    expect(recs.every((r) => r.v === TRACE_VERSION)).toBe(true);
    expect(recs.every((r) => r.runId === "run-abc")).toBe(true);
    expect(recs.map((r) => r.seq)).toEqual([0, 1]); // monotonic
    expect(recs[0].type).toBe("run_start");
    expect((recs[1] as any).entities).toBe(3);
  });

  it("never throws on an unwritable path (best-effort side channel)", () => {
    // a path whose parent is a file, not a dir → mkdir/append fail
    const filePath = path.join(tmp, "afile");
    fs.writeFileSync(filePath, "x");
    trace.configure({ enabled: true, path: path.join(filePath, "nope.jsonl"), runId: "r" });
    expect(() =>
      trace.emit({ stage: "export", type: "export", format: "json", entities: 0, relations: 0 })
    ).not.toThrow();
  });

  it("resets seq + lineage on reconfigure", () => {
    trace.configure({ enabled: true, path: out, runId: "r1" });
    trace.emit({ stage: "export", type: "export", format: "json", entities: 1, relations: 1 });
    trace.configure({ enabled: true, path: out, runId: "r2" });
    fs.rmSync(out, { force: true });
    trace.emit({ stage: "export", type: "export", format: "json", entities: 2, relations: 2 });
    expect(readRecords()[0].seq).toBe(0);
  });

  // WS-61: a fresh (non-resumed) configure must truncate a stale sidecar so a
  // re-run doesn't leave duplicate events from the prior run (seq restarts per
  // run, so they'd be indistinguishable). A resumed run keeps & appends.
  it("truncates a stale sidecar on a fresh (non-resumed) configure", () => {
    trace.configure({ enabled: true, path: out, runId: "r1" });
    trace.emit({ stage: "export", type: "export", format: "json", entities: 1, relations: 1 });
    expect(readRecords()).toHaveLength(1);

    // fresh run at the SAME path — prior event must be gone, not appended to.
    trace.configure({ enabled: true, path: out, runId: "r2", resumed: false });
    trace.emit({ stage: "export", type: "export", format: "json", entities: 2, relations: 2 });
    const recs = readRecords();
    expect(recs).toHaveLength(1);
    expect(recs[0].runId).toBe("r2");
    expect((recs[0] as any).entities).toBe(2);
  });

  it("appends (does NOT truncate) on a resumed configure", () => {
    trace.configure({ enabled: true, path: out, runId: "r1" });
    trace.emit({ stage: "export", type: "export", format: "json", entities: 1, relations: 1 });

    // resumed run at the SAME path — prior events are intentionally preserved.
    trace.configure({ enabled: true, path: out, runId: "r2", resumed: true });
    trace.emit({ stage: "export", type: "export", format: "json", entities: 2, relations: 2 });
    const recs = readRecords();
    expect(recs).toHaveLength(2);
    expect(recs.map((r) => r.runId)).toEqual(["r1", "r2"]);
  });

  it("does not create a file on configure alone (only the truncate runs lazily-safe)", () => {
    // Truncating ensures a clean start; no events ⇒ the file is empty but present.
    trace.configure({ enabled: true, path: out, runId: "r1", resumed: false });
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.readFileSync(out, "utf-8")).toBe("");
  });

  // WS-62: vestigial fields dropped from the event taxonomy. The extraction
  // event no longer carries `attempt` and the export event no longer carries
  // `droppedByGate` (both were always-0 / never-set).
  it("extraction + export events carry no vestigial fields", () => {
    trace.configure({ enabled: true, path: out, runId: "r1" });
    trace.emit({
      stage: "extract", type: "extraction",
      extractionId: "f.txt#0@0", chunkId: "f.txt#0", file: "f.txt", chunkIndex: 0,
      model: "m", promptVersion: "v5", checkpointHit: false,
      entityMentions: [], relationMentions: [],
    });
    trace.emit({ stage: "export", type: "export", format: "json", entities: 1, relations: 0 });
    const [ext, exp] = readRecords() as any[];
    expect("attempt" in ext).toBe(false);
    expect("droppedByGate" in exp).toBe(false);
  });
});
