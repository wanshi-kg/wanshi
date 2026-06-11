# Changelog

## Gmail API migration (Phase 1)

Migrated the mail listener from **IMAP to the Gmail API** with OAuth2, and wired the
mail watcher into the kg-gen pipeline + Telegram controls.

**Email client**
- `imap-simple`/`mailparser`/`nodemailer` → `googleapis` + `google-auth-library`.
- Auth: app-specific password → browser OAuth2 flow; credentials in a local
  `token.json` (gitignored) instead of `.env`. Works with 2FA normally.
- Polling: unreliable IMAP IDLE → stable 30-second Gmail API polling, with graceful
  degradation on errors.

**Code**
- `src/services/MailListener.ts` — rewritten for the Gmail API (OAuth2, message
  polling, header/body extraction, token persistence).
- `scripts/gmail-auth.ts` — new `npm run gmail:auth` helper: validates
  `credentials.json`, runs the OAuth2 flow, writes `token.json`.
- `src/services/{KnowledgeGraphBuilder,TelegramBot}.ts` + `src/index.ts` — mail →
  kg-gen graph build, surfaced through Telegram chat controls.

**Setup docs** (kept alongside this file): `README.md`, `QUICK_START.md`,
`GMAIL_SETUP.md`, `ENV_SETUP.md`, `TROUBLESHOOTING.md`.

> History note: this entry consolidates a set of per-step completion reports
> (`*_COMPLETE.md`, `*_READY.md`, `MIGRATION_SUMMARY.md`, `INDEX.md`) generated
> during the build, removed here in favor of one changelog.
