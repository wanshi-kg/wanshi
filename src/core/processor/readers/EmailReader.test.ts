import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { EmailReader, EmailReaderOptions } from "./EmailReader";
import { TextChunker } from "../chunking/TextChunker";
import { stubLogger } from "../../../__tests__/helpers";

const OPTS: EmailReaderOptions = { maxMessages: 1000, stripQuotes: true };

describe("EmailReader", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kgmail-"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const reader = (opts: EmailReaderOptions = OPTS, maxChunkSize = 4000) => {
    const chunker = new TextChunker(
      { maxChunkSize, overlapSize: 50, enabled: true },
      stubLogger()
    );
    return new EmailReader(chunker, stubLogger(), maxChunkSize, opts);
  };

  const write = (name: string, content: string) => {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, content);
    return p;
  };

  it("parses a single .eml → one turn with sender speaker, ISO date, subject+body", async () => {
    const p = write(
      "kickoff.eml",
      [
        "From: Alice Smith <alice@example.com>",
        "To: Bob <bob@example.com>",
        "Subject: Project kickoff",
        "Date: Mon, 02 Jun 2025 10:00:00 +0000",
        "Message-ID: <msg1@example.com>",
        "",
        "Hi Bob, the project starts Monday. Acme Corp provides the budget.",
      ].join("\n")
    );
    const res = await reader().read(p);
    expect(res.chunks).toHaveLength(1);
    const c = res.chunks[0];
    expect(c.content).toContain("Subject: Project kickoff");
    expect(c.content).toContain("Acme Corp provides the budget");
    // sender → speaker (display name), Date header → occurredAt (validAt), file → source
    expect(c.provenance?.speaker).toBe("Alice Smith");
    expect(c.provenance?.occurredAt).toBe("2025-06-02T10:00:00.000Z");
    expect(c.provenance?.source).toBe(p);
  });

  it("decodes an HTML-only body and drops nav/footer boilerplate", async () => {
    const p = write(
      "digest.eml",
      [
        "From: News <news@site.com>",
        "Subject: Weekly digest",
        "Date: Tue, 03 Jun 2025 09:00:00 +0000",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<html><body><nav>Home About Contact</nav><h1>Big News</h1>" +
          "<p>Acme acquired Foo Inc.</p><footer>Unsubscribe here</footer></body></html>",
      ].join("\n")
    );
    const res = await reader().read(p);
    const text = res.chunks.map((c) => c.content).join("\n");
    expect(text).toContain("Big News");
    expect(text).toContain("Acme acquired Foo Inc.");
    expect(text).not.toContain("Unsubscribe here"); // <footer> skipped
    expect(text).not.toContain("Home About Contact"); // <nav> skipped
  });

  it("strips a quoted reply chain so only the new content remains", async () => {
    const p = write(
      "reply.eml",
      [
        "From: Bob <bob@example.com>",
        "Subject: Re: Question",
        "Date: Wed, 04 Jun 2025 08:00:00 +0000",
        "",
        "Thanks, that works for me.",
        "",
        "On Mon, Jun 2, 2025 at 10:00 AM Alice <alice@example.com> wrote:",
        "> Can you review the doc?",
        "> It is urgent.",
      ].join("\n")
    );
    const res = await reader().read(p);
    const text = res.chunks.map((c) => c.content).join("\n");
    expect(text).toContain("Thanks, that works for me");
    expect(text).not.toContain("Can you review the doc");
  });

  it("WS-48: strips a quoted reply whose 'On … wrote:' attribution wraps across two lines", async () => {
    const p = write(
      "wrapped.eml",
      [
        "From: Bob <bob@example.com>",
        "Subject: Re: Question",
        "Date: Wed, 04 Jun 2025 08:00:00 +0000",
        "",
        "Yes, ship it.",
        "",
        // attribution wrapped: the address pushes "wrote:" onto the next line
        "On Mon, Jun 2, 2025 at 10:00 AM Alice Smith <alice@example.com>",
        "wrote:",
        "> Should we ship the release?",
        "> Please confirm.",
      ].join("\n")
    );
    const res = await reader().read(p);
    const text = res.chunks.map((c) => c.content).join("\n");
    expect(text).toContain("Yes, ship it");
    expect(text).not.toContain("Should we ship the release"); // wrapped attribution detected → quote dropped
    expect(text).not.toContain("Please confirm");
    expect(text).not.toMatch(/wrote:/);
  });

  it("WS-49: mbox does NOT split on a prose line beginning 'From … <year>'", async () => {
    const p = write(
      "prose-from.mbox",
      [
        "From alice@example.com Mon Jun 02 10:00:00 2025",
        "From: Alice <alice@example.com>",
        "Subject: History",
        "Date: Mon, 02 Jun 2025 10:00:00 +0000",
        "Message-ID: <a1@example.com>",
        "",
        "Here is the story.",
        "From the 2024 summit we learned a great deal about owls.",
        "That concludes the recap.",
        "",
      ].join("\n")
    );
    const res = await reader().read(p);
    // One envelope → one message; the prose 'From … 2024' line must NOT start a new block.
    expect((res.metadata as any)?.messages).toBe(1);
    const text = res.chunks.map((c) => c.content).join("\n");
    expect(text).toContain("Here is the story.");
    expect(text).toContain("From the 2024 summit we learned"); // prose line preserved in-body
    expect(text).toContain("That concludes the recap.");
  });

  it("keeps the quoted chain when stripQuotes is off", async () => {
    const p = write(
      "reply2.eml",
      [
        "From: Bob <bob@example.com>",
        "Subject: Re: Question",
        "Date: Wed, 04 Jun 2025 08:00:00 +0000",
        "",
        "Sounds good.",
        "",
        "On Mon, Jun 2, 2025 at 10:00 AM Alice wrote:",
        "> The original ask.",
      ].join("\n")
    );
    const res = await reader({ maxMessages: 1000, stripQuotes: false }).read(p);
    const text = res.chunks.map((c) => c.content).join("\n");
    expect(text).toContain("The original ask");
  });

  it("packs two messages of the same thread into one chunk", async () => {
    const p = write(
      "thread.mbox",
      [
        "From alice@example.com Mon Jun 02 10:00:00 2025",
        "From: Alice <alice@example.com>",
        "Subject: Planning",
        "Date: Mon, 02 Jun 2025 10:00:00 +0000",
        "Message-ID: <a1@example.com>",
        "",
        "Let us meet about apples on Monday.",
        "",
        "From bob@example.com Mon Jun 02 11:00:00 2025",
        "From: Bob <bob@example.com>",
        "Subject: Re: Planning",
        "Date: Mon, 02 Jun 2025 11:00:00 +0000",
        "Message-ID: <b1@example.com>",
        "In-Reply-To: <a1@example.com>",
        "References: <a1@example.com>",
        "",
        "Monday works for me.",
        "",
      ].join("\n")
    );
    const res = await reader().read(p);
    expect(res.chunks).toHaveLength(1); // same thread → one conversation → packed together
    const c = res.chunks[0];
    expect(c.content).toContain("Alice: ");
    expect(c.content).toContain("Bob: ");
    expect(c.content).toContain("apples");
    expect(c.content).toContain("Monday works for me");
  });

  it("never packs two different threads into one chunk (KG-10 boundary)", async () => {
    const p = write(
      "two-threads.mbox",
      [
        "From alice@example.com Mon Jun 02 10:00:00 2025",
        "From: Alice <alice@example.com>",
        "Subject: Apples",
        "Date: Mon, 02 Jun 2025 10:00:00 +0000",
        "Message-ID: <a1@example.com>",
        "",
        "A note about apples.",
        "",
        "From carol@example.com Tue Jun 03 09:00:00 2025",
        "From: Carol <carol@example.com>",
        "Subject: Bananas",
        "Date: Tue, 03 Jun 2025 09:00:00 +0000",
        "Message-ID: <c1@example.com>",
        "",
        "A separate note about bananas.",
        "",
      ].join("\n")
    );
    const res = await reader().read(p);
    expect(res.chunks).toHaveLength(2); // distinct threads → distinct conversations → never share a chunk
    const joined = res.chunks.map((c) => c.content);
    expect(joined.some((t) => t.includes("apples"))).toBe(true);
    expect(joined.some((t) => t.includes("bananas"))).toBe(true);
  });

  it("does not throw on non-email content (graceful)", async () => {
    const p = write("junk.eml", "this is not really an email, just some loose text");
    const res = await reader().read(p);
    expect(res.chunks.length).toBeGreaterThanOrEqual(1);
  });

  it("claims .eml/.mbox and defers other extensions", () => {
    const r = reader();
    expect(r.canRead("/x/a.eml")).toBe(true);
    expect(r.canRead("/x/a.mbox")).toBe(true);
    expect(r.canRead("/x/notes.md")).toBe(false);
    expect(r.adapterId()).toBe("email");
  });
});
