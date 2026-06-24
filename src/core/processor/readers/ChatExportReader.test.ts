import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ChatExportReader, ChatReaderOptions } from "./ChatExportReader";
import { TextChunker } from "../chunking/TextChunker";
import { stubLogger } from "../../../__tests__/helpers";

const OPTS: ChatReaderOptions = { maxMessages: 50000, skipSystem: true };

describe("ChatExportReader", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kgchat-"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const reader = (opts: ChatReaderOptions = OPTS, maxChunkSize = 4000) => {
    const chunker = new TextChunker(
      { maxChunkSize, overlapSize: 50, enabled: true },
      stubLogger()
    );
    return new ChatExportReader(chunker, stubLogger(), maxChunkSize, opts);
  };

  const write = (name: string, content: string) => {
    const p = path.join(tmp, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    return p;
  };

  const allText = (chunks: { content: string }[]) => chunks.map((c) => c.content).join("\n");

  it("WhatsApp (iOS) — sender→speaker, continuation joined, system line skipped", async () => {
    const p = write(
      "chat.txt",
      [
        "[15/01/2023, 14:30:00] Messages and calls are end-to-end encrypted.",
        "[15/01/2023, 14:30:45] Alice: Hello Bob",
        "[15/01/2023, 14:31:02] Bob: Hi Alice, how are you?",
        "this is a continuation line",
      ].join("\n")
    );
    const res = await reader().read(p);
    const text = allText(res.chunks);
    expect(text).toContain("Alice: Hello Bob");
    expect(text).toContain("how are you?");
    expect(text).toContain("this is a continuation line"); // appended to Bob's turn
    expect(text).not.toContain("end-to-end encrypted"); // system notice dropped
    expect(res.chunks[0].provenance?.sourceAdapter).toBe("chat:whatsapp");
    expect(res.chunks[0].provenance?.occurredAt).toMatch(/^2023-01-15T/);
  });

  it("WhatsApp (Android) — dash format, <Media omitted> dropped", async () => {
    const p = write(
      "android.txt",
      ["15/01/2023, 14:30 - Carol: Android format works", "15/01/2023, 14:31 - Carol: <Media omitted>"].join("\n")
    );
    const res = await reader().read(p);
    const text = allText(res.chunks);
    expect(text).toContain("Carol: Android format works");
    expect(text).not.toContain("Media omitted");
  });

  it("WS-26: continuation of a DROPPED system message does not leak into the prior turn", async () => {
    const p = write(
      "wa-sys-cont.txt",
      [
        "[15/01/2023, 14:30:45] Alice: real user message",
        "[15/01/2023, 14:31:00] Messages and calls are end-to-end encrypted.",
        "Tap to learn more.", // continuation of the dropped system notice
        "[15/01/2023, 14:32:00] Bob: another real message",
      ].join("\n")
    );
    const res = await reader().read(p);
    const text = allText(res.chunks);
    expect(text).toContain("Alice: real user message");
    expect(text).toContain("Bob: another real message");
    expect(text).not.toContain("end-to-end encrypted"); // system notice dropped
    expect(text).not.toContain("Tap to learn more"); // its continuation swallowed, NOT leaked into Alice's turn
  });

  it("WS-26: continuation IS appended when the system message is kept (skipSystem off)", async () => {
    const p = write(
      "wa-sys-keep.txt",
      [
        "[15/01/2023, 14:31:00] Messages and calls are end-to-end encrypted.",
        "Tap to learn more.",
      ].join("\n")
    );
    const res = await reader({ maxMessages: 50000, skipSystem: false }).read(p);
    const text = allText(res.chunks);
    expect(text).toContain("end-to-end encrypted");
    expect(text).toContain("Tap to learn more"); // continuation joins the kept system turn
  });

  it("WS-50: Slack labeled mentions <@U…|name> and <!here>/<!channel> are resolved, not leaked raw", async () => {
    const p = write(
      "general/2023-02-01.json",
      JSON.stringify([
        { type: "message", user: "U1", text: "hey <@U2|bob> and <!here> and <!channel>", ts: "1675238400.000100" },
      ])
    );
    const res = await reader().read(p);
    const text = allText(res.chunks);
    expect(text).toContain("@bob"); // labeled mention → label
    expect(text).toContain("@here"); // special mention resolved
    expect(text).toContain("@channel");
    expect(text).not.toContain("<@U2|bob>"); // raw syntax gone
    expect(text).not.toContain("<!here>");
    expect(text).not.toContain("<!channel>");
  });

  it("Telegram — text_entities flattened, date_unixtime→ISO, service msg skipped", async () => {
    const p = write(
      "result.json",
      JSON.stringify({
        about: "Telegram Desktop Export",
        name: "Test Chat",
        type: "personal_chat",
        messages: [
          { id: 1, type: "service", date: "2023-01-15T14:00:00", action: "create_group", text: "" },
          {
            id: 2, type: "message", date: "2023-01-15T14:30:00", date_unixtime: "1673793000",
            from: "Alice", text: "Plain message", text_entities: [{ type: "plain", text: "Plain message" }],
          },
          {
            id: 3, type: "message", date: "2023-01-15T14:31:00", date_unixtime: "1673793060",
            from: "Bob", text: ["see ", { type: "link", text: "https://x.com" }],
            text_entities: [{ type: "plain", text: "see " }, { type: "link", text: "https://x.com" }],
          },
        ],
      })
    );
    const res = await reader().read(p);
    const text = allText(res.chunks);
    expect(text).toContain("Alice: Plain message");
    expect(text).toContain("Bob: see https://x.com"); // array entities flattened
    expect(text).not.toContain("create_group"); // service message skipped
    expect(res.chunks[0].provenance?.sourceAdapter).toBe("chat:telegram");
    expect(res.chunks[0].provenance?.occurredAt).toBe("2023-01-15T14:30:00.000Z");
  });

  it("Discord (DiscordChatExporter) — nickname→speaker, system type skipped", async () => {
    const p = write(
      "discord.json",
      JSON.stringify({
        guild: { id: "1", name: "Test Guild" },
        channel: { id: "2", name: "general" },
        exportedAt: "2023-01-16T00:00:00Z",
        messages: [
          { id: "10", type: "Default", timestamp: "2023-01-15T14:30:00.000+00:00", author: { id: "100", name: "alice", nickname: "Alice A" }, content: "Hey there" },
          { id: "11", type: "ChannelPinnedMessage", timestamp: "2023-01-15T14:31:00.000+00:00", author: { id: "100", name: "alice" }, content: "pinned a message" },
        ],
      })
    );
    const res = await reader().read(p);
    const text = allText(res.chunks);
    expect(text).toContain("Alice A: Hey there"); // nickname preferred
    expect(text).not.toContain("pinned a message"); // system type skipped
    expect(res.chunks[0].provenance?.sourceAdapter).toBe("chat:discord");
  });

  it("Slack — resolves user ids + <@mentions> from users.json sidecar, skips joins", async () => {
    write(
      "users.json",
      JSON.stringify([
        { id: "U1", name: "alice", real_name: "Alice Anderson", profile: { display_name: "alice_a" } },
        { id: "U2", name: "bob", real_name: "Bob Brown", profile: { display_name: "" } },
      ])
    );
    const p = write(
      "general/2023-01-15.json",
      JSON.stringify([
        { type: "message", user: "U1", text: "Hi <@U2> check this", ts: "1673793000.000100" },
        { type: "message", subtype: "channel_join", user: "U2", text: "<@U2> has joined the channel", ts: "1673793100.000200" },
        { type: "message", user: "U2", text: "thanks!", ts: "1673793200.000300" },
      ])
    );
    const res = await reader().read(p);
    const text = allText(res.chunks);
    expect(text).toContain("alice_a: Hi @Bob Brown check this"); // U1→display_name, <@U2>→real_name
    expect(text).toContain("Bob Brown: thanks!");
    expect(text).not.toContain("has joined the channel"); // channel_join subtype skipped
    expect(res.chunks[0].provenance?.sourceAdapter).toBe("chat:slack");
  });

  it("keeps system messages when skipSystem is off", async () => {
    const p = write(
      "sys.txt",
      ["[15/01/2023, 14:30:00] Messages and calls are end-to-end encrypted.", "[15/01/2023, 14:30:45] Alice: hi"].join("\n")
    );
    const res = await reader({ maxMessages: 50000, skipSystem: false }).read(p);
    expect(allText(res.chunks)).toContain("end-to-end encrypted");
  });

  it("claims chat-shaped files and defers plain text / generic json", () => {
    const r = reader();
    const wa = write("c.txt", "[15/01/2023, 14:30:45] Alice: hi");
    const plain = write("notes.txt", "just some plain notes\nwith no timestamps at all");
    const tg = write("tg.json", JSON.stringify({ about: "Telegram Desktop Export", messages: [] }));
    const generic = write("data.json", JSON.stringify({ foo: "bar", items: [1, 2, 3] }));
    expect(r.canRead(wa)).toBe(true);
    expect(r.canRead(tg)).toBe(true);
    expect(r.canRead(plain)).toBe(false); // plain text defers to TextReader
    expect(r.canRead(generic)).toBe(false); // generic json defers to JsonFileReader
    expect(r.canRead("/x/notes.md")).toBe(false);
    expect(r.adapterId()).toBe("chat");
  });

  it("does not throw on a chat-sniffed file with broken JSON (graceful)", async () => {
    const p = write("broken.json", '{"messages":[ "text_entities" this is not valid json at all ........');
    const res = await reader().read(p);
    expect(Array.isArray(res.chunks)).toBe(true); // plainFallback, no throw
  });
});
