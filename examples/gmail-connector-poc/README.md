# gmail-connector-poc

A **proof-of-concept Gmail/OAuth2 connector** — the *live-source* half of email ingestion,
preserved for future iteration. It is **not a wired, runnable app**; it's the connector source
carved out of the retired `kg-mail-assistant` example when its reusable ideas moved into wanshi's
offline **`EmailReader`** (`.eml`/`.mbox`).

## Why this exists

wanshi is a **batch tool**: point it at a directory of files. The natural, supported way to ingest
email today is to export it to `.eml`/`.mbox` and let `EmailReader` map each message to a
provenance-rich conversational turn (sender → `speaker`, `Date:` → `validAt`, threads → conversation
graphs). That path is offline, deterministic, and tested.

A *live* Gmail source — polling the API, streaming new mail into the graph — is a different,
streaming paradigm that wanshi doesn't have (and deliberately didn't grow for one example). This
PoC keeps the hard part (OAuth2 + Gmail API polling + MIME/HTML body extraction) intact so a future
"live data-source" feature can start from working code instead of from scratch.

## What's here

- **`MailListener.ts`** — the connector: OAuth2 auth, 30s polling of unread mail, MIME parse,
  HTML→text body extraction, and an `EmailFilterConfig` (domain/sender/subject/age filters). Emits
  parsed `Email` objects via a handler/event.
- **`gmail-auth.ts`** — one-time OAuth2 token minter (`npm run gmail:auth` → writes `token.json`).
- **`GMAIL_SETUP.md` / `ENV_SETUP.md`** — Google Cloud + credential setup.
- **`.env.example`** — the two required vars (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`).

## Wiring it (future work)

A live integration would have `MailListener`'s handler write each `Email` to a `.eml`/`.txt` in a
watched directory and let wanshi's watch mode + `EmailReader` extract it — i.e. the connector becomes
a *source adapter* feeding the same offline pipeline, keeping all graph logic in one place.

**The reusable extraction ideas (structure-preserving html-to-text, `Name <addr>` sender parsing,
header-as-provenance) already live in `src/core/processor/readers/EmailReader.ts`.**
