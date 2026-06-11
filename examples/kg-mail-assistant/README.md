# KG Mail Assistant

Example on how to integrate a kg-gen tool with Gmail API to make a smart agentic personal assistant with Telegram chat controls.

## Tech Stack

- NodeJs
- TypeScript
- kg-gen
- Gmail API (OAuth2)
- node-telegram-bot-api

## Agents Structure

- Telegram chatbot interface model
- kg-gen graph builder (each new message updates existing graph)
- once a day agent that summarizes knowledge graph for past day and sends message with report if any
- agent that sends message to a user immediately if important email received

## Project Setup

### Prerequisites

- Node.js 18+ with npm
- Google account (for Gmail API access)
- Telegram bot token (create via [@BotFather](https://t.me/botfather))
- Ollama or other LLM service (optional, for local LLM support)

### Quick Start (5 minutes)

1. **Install dependencies:**

   ```bash
   npm install
   ```

2. **Setup Gmail API:**

   Follow the **[Gmail API Setup Guide](./GMAIL_SETUP.md)** for step-by-step instructions on:
   - Creating a Google Cloud project
   - Enabling Gmail API
   - Obtaining OAuth2 credentials
   - Running authentication setup

3. **Configure Telegram:**

   ```bash
   cp .env.example .env
   ```

   Update the `.env` file with:
   - Telegram bot token (from [@BotFather](https://t.me/botfather))
   - Telegram user ID (your numeric ID)
   - KG-Gen configuration (optional)

### Running in Continuous Mode

Start the assistant:

```bash
npm run start
```

This will:

- Connect to your Gmail account via OAuth2
- Listen for incoming Telegram commands
- Process new emails in real-time
- Update the knowledge graph continuously

**For development with watch mode:**

```bash
npm run dev
```

## 📧 How It Works

### Email Processing

1. **Gmail Authentication**: Uses OAuth2 - no passwords stored!
2. **Polling**: Checks for unread emails every 30 seconds
3. **Email Extraction**: Parses sender, subject, date, and body
4. **Knowledge Graph**: Converts emails to structured knowledge entries
5. **Telegram Notifications**: Alerts you via Telegram bot

### Telegram Commands

- `/status` - Show current graph statistics
- `/summary` - Generate daily summary
- `/reset` - Clear the knowledge graph

### Output

Knowledge graphs are stored in `./data/graphs/` as JSONL files (one per day):

```json
{"timestamp":"2024-01-15T10:30:00Z","source":"gmail","from":"user@example.com","subject":"Meeting Notes","entities":["person","project"],"text":"..."}
```

## TODO / ROADMAP

### Phase 1: Core Mail Integration ✅ (Complete)

- ✅ Gmail API integration using `googleapis` package
  - ✅ OAuth2 authentication (no passwords needed!)
  - ✅ Email polling (30-second intervals)
  - ✅ Email parsing and extraction
  - ✅ Error handling and graceful degradation
- ✅ Telegram bot integration
  - ✅ Command parsing (`/status`, `/summary`, `/reset`)
  - ✅ Real-time notifications
  - ✅ User authentication

### Phase 2: KG-Gen Integration 🚀 (In Progress)

- [ ] Integrate with kg-gen ContainerFactory
  - [ ] File processing pipeline
  - [ ] Entity extraction from email content
  - [ ] Relationship building
  - [ ] Observation logging
- [ ] Email-to-knowledge-graph mapping
- [ ] Graph update and merging strategies
- [ ] Persistence layer for knowledge graphs

### Phase 3: Automated Agents 🕐 (Planned)

- [ ] Daily summary agent
  - [ ] Schedule-based execution
  - [ ] KG summarization using LLM
- [ ] Importance detection
  - [ ] Detect important emails automatically
  - [ ] Send immediate Telegram alerts
  - [ ] Configurable filters

### Phase 4: Advanced Features 🎯 (Future)

- [ ] Email threading (group related emails)
- [ ] Attachment processing
- [ ] Multiple Gmail accounts support
- [ ] Knowledge graph visualization
- [ ] Export in multiple formats (DOT, JSON, RDF)
- [ ] LLM-based email categorization
- [ ] Natural language queries on emails
- [ ] Weekly/monthly analytics reports

- [ ] Daily summary agent
  - [ ] Schedule-based execution
  - [ ] KG summarization using LLM
  - [ ] Report generation and sending
- [ ] Important email detector
  - [ ] Importance scoring algorithm
  - [ ] Real-time alert system
  - [ ] Context-aware notifications

### Phase 5: Advanced Features 📊

- [ ] Graph analytics and statistics
- [ ] Semantic search over emails
- [ ] Multi-user support
- [ ] Conversation threading
- [ ] Email classification by topic
- [ ] Duplicate detection and merging
- [ ] Export formats (JSON, JSONL, MCP)

### Phase 6: Deployment & Optimization 🚀

- [ ] Docker support
- [ ] Configuration validation
- [ ] Error recovery mechanisms
- [ ] Performance optimization
- [ ] Monitoring and logging
- [ ] Unit and integration tests

## Architecture

```text
┌─────────────────┐
│   Telegram      │
│   Bot (⌨️)      │
└────────┬────────┘
         │
    ┌────┴────┐
    │   Main   │
    │  App    │
    └────┬────┘
         │
    ┌────┴─────────────────┐
    │                      │
┌───▼──────┐        ┌─────▼──────┐
│   Mail    │        │ Knowledge  │
│ Listener  │        │  Graph     │
│ (IMAP)    │        │  Builder   │
└───┬──────┘        │ (kg-gen)   │
    │               └────┬───────┘
    │                    │
┌───▼─────────────────────▼────┐
│   File System / Database     │
│   (emails, graphs)           │
└──────────────────────────────┘
```

## Running Tests

```bash
npm test
```

## Building for Production

```bash
npm run build
```

The compiled JavaScript will be in the `dist/` directory.
