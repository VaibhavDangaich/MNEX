# 🤖 AI CLI Agent

> **A persistent personal context agent that remembers everything you do across your entire machine.**

The AI CLI Agent is your digital cognitive layer — it continuously monitors your terminal commands, file edits, and git changes, building a semantic memory of your work. Ask questions naturally without explaining context; the agent already knows what you've been working on.

---

## ✨ Vision

Imagine never having to explain "I was working on that React component earlier" or "remember that API error I fixed yesterday?" This agent watches your work silently, builds understanding, and answers questions with full context of your recent activity.

```bash
# From ANY directory on your machine
$ ai ask "what was I working on today?"

🤖 AI Agent
────────────────────────────────────────
📍 Directory: tmp (not a project)
⚡ Recent: 12 command(s)
💾 Memory: 5 item(s)
────────────────────────────────────────

💬 Response:
You were working on the cli_agent project today. Specifically:
- Updated the memory module to add global context tracking
- Fixed the git diff capture in gitmonitor.js
- Modified prompt.js to include code changes in AI responses
- Ran several test commands from /tmp to verify cross-project awareness
```

---

## 🚀 Features

### 🧠 Three-Layer Memory System

| Layer | Purpose | Retention |
|-------|---------|-----------|
| **Episodic** | Recent activity (commands, file edits) | 3 hours |
| **Working** | Current session context (tasks, blockers) | Session |
| **Semantic** | Long-term facts + Supermemory cloud | Permanent |

### 🌍 Global Context Awareness

The agent knows what you're doing across **ALL** your projects, not just the current directory. Ask from `/tmp` and it still knows you were editing `cli_agent/core/prompt.js`.

### 📝 Real Code Change Tracking

See **exact git diffs** in responses. When you ask "what changed?", the AI shows actual code modifications:

```diff
+ function buildGitSection(context) {
+     if (!context.isGitRepo) return "";
+     return gitmonitor.formatForPrompt(context.cwd);
+ }
```

### 👁️ Editor-Agnostic File Monitoring

Works with **any editor** — VS Code, Vim, Emacs, Sublime, IntelliJ. Uses file system watching, not editor plugins.

### 🔌 Supermemory Integration

Optionally sync to [Supermemory](https://supermemory.ai) for semantic search across your entire work history.

---

## 📦 Installation

### Prerequisites

- Node.js 18+ 
- Git (recommended for best experience)
- OpenAI or Gemini API key

### Install

```bash
# Clone the repository
git clone https://github.com/VaibhavDangaich/cli_agent.git
cd cli_agent

# Install dependencies
npm install

# Link globally
npm link
```

### Post-Install Notice

```
⚠️  RECOMMENDED: Initialize git in your project folders!

The AI agent works best when your projects are git-initialized:
✓ Track your code changes with precise diffs
✓ Know exactly what you modified in each file  
✓ Answer "what did I change?" with actual code
```

---

## ⚙️ Configuration

### 1. Create `.env` File

```bash
cp .env.example .env
```

Edit `.env` with your API keys:

```env
# Required: Choose one LLM provider
OPENAI_API_KEY=sk-proj-your-openai-key-here
# OR
GEMINI_API_KEY=your-gemini-key-here

# Optional: Supermemory for semantic search
SUPERMEMORY_API_KEY=sm_your-supermemory-key-here
```

### 2. Enable Terminal Monitoring (Recommended)

Add to your `~/.zshrc`:

```bash
source /path/to/cli_agent/hooks/zsh-hook.sh
```

Then reload:

```bash
source ~/.zshrc
ai-monitor on  # Enable monitoring
```

### 3. Start File Watcher (Optional)

Monitor file changes from any editor:

```bash
ai watch ~/code  # Watch your code directory
```

---

## 📖 Usage

### Core Commands

#### `ai ask "question"`

Ask the AI anything. It has full context of your recent work.

```bash
ai ask "what was I working on?"
ai ask "what error did I encounter earlier?"
ai ask "summarize my changes today"
ai ask "what files did I modify in the auth module?"
```

Options:
- `-d, --debug` — Show the full prompt being sent to the LLM

#### `ai remember "fact"`

Store important information for long-term recall.

```bash
ai remember "the production API is at api.example.com"
ai remember "use snake_case for database columns"
ai remember "auth tokens expire after 24 hours"
```

#### `ai task "description"`

Set your current task for better context.

```bash
ai task "implementing user authentication"
ai task "fixing the payment bug in checkout"
ai task done  # Clear current task
```

### Monitoring Commands

#### `ai watch [path]`

Start file watcher for editor-agnostic monitoring.

```bash
ai watch .           # Watch current directory
ai watch ~/projects  # Watch all projects
```

#### `ai-monitor on|off`

Toggle terminal command monitoring (requires shell hook).

```bash
ai-monitor on   # Start capturing commands
ai-monitor off  # Stop capturing
```

#### `ai log "command" --cwd /path`

Manually log a command (used internally by shell hook).

```bash
ai log "npm test" --cwd /Users/me/project --exit 0
```

### Information Commands

#### `ai status`

Show current context and monitoring state.

```bash
$ ai status

📊 AI Agent Status
────────────────────────────────────────
📁 Project: cli_agent
🌿 Branch: master
🧠 Memory: 5 items stored
⏱️  Episodic: 12 recent events
👁️  File watcher: Running
🖥️  Terminal monitor: Enabled
```

#### `ai history`

Show recent command history from episodic memory.

```bash
$ ai history

Recent Activity:
────────────────────────────────────────
[✓] git commit -m "add memory layer"
[✓] npm test
[✗] node broken-script.js
[✓] ai ask "what went wrong?"
```

#### `ai memory`

Display stored memories for current project.

```bash
$ ai memory

💾 Stored Memories (cli_agent):
────────────────────────────────────────
1. The API key is stored in .env
2. Use CommonJS modules, not ESM
3. Supermemory SDK uses client.add()
```

### Setup & Debug Commands

#### `ai setup`

Show setup instructions for shell hook and file watcher.

#### `ai supermemory`

Debug Supermemory connection and test storage.

```bash
ai supermemory --store "test memory"   # Store a test memory
ai supermemory --query "test"          # Search memories
ai supermemory --list                  # List all memories
```

---

## 🏗️ Architecture

```
cli_agent/
├── bin/
│   └── ai.js              # CLI entry point (Commander.js)
│
├── core/
│   ├── config.js          # Configuration manager
│   ├── context.js         # Git & project detection
│   ├── llm.js             # LLM calls (OpenAI/Gemini)
│   ├── prompt.js          # LangChain prompt templates
│   │
│   ├── memory/
│   │   ├── index.js       # Unified memory interface
│   │   ├── episodic.js    # Short-term activity (3hr)
│   │   ├── working.js     # Session context
│   │   ├── local.js       # Local JSON storage
│   │   └── supermemory.js # Supermemory SDK integration
│   │
│   └── monitor/
│       ├── terminal.js    # Terminal event processor
│       ├── filewatcher.js # Chokidar file watcher
│       ├── gitmonitor.js  # Git diff capture
│       └── extractor.js   # LLM-based context extraction
│
├── hooks/
│   └── zsh-hook.sh        # Shell hook for terminal monitoring
│
├── storage/
│   ├── memory.json        # Long-term memories
│   ├── episodic.json      # Recent activity
│   └── working.json       # Session context
│
└── config/
    └── default.json       # Default configuration
```

---

## 🧠 How Memory Works

### The Three Layers

#### 1. Episodic Memory (Short-Term)

Stores raw activity events for the last 3 hours:
- Terminal commands with exit codes
- File create/save/delete events
- Git commits with diffs

```json
{
  "type": "terminal",
  "command": "npm test",
  "exitCode": 0,
  "project": "cli_agent",
  "timestamp": "2026-02-01T10:30:00Z"
}
```

#### 2. Working Memory (Session)

Tracks current session context:
- Current task description
- Recent blockers/errors
- Key decisions made

```json
{
  "currentTask": "implementing auth",
  "blockers": ["OAuth callback not working"],
  "lastActivity": "2026-02-01T10:30:00Z"
}
```

#### 3. Semantic Memory (Long-Term)

Permanent storage for important facts:
- **Local**: JSON file for quick recall
- **Supermemory**: Cloud semantic search

```json
{
  "cli_agent": [
    "Use CommonJS modules",
    "API key stored in .env",
    "Supermemory SDK: client.add()"
  ]
}
```

### Global Context

When you ask a question, the agent gathers context from:

1. **Current project** — Episodic + Working + Local memory
2. **All recent projects** — Global activity feed
3. **Git state** — Uncommitted changes + recent commits
4. **Semantic search** — Supermemory query results

This means asking from `/tmp` still shows your `cli_agent` work!

---

## 🔧 Project Detection

The agent distinguishes real projects from random directories:

**Recognized as projects:**
- Git repositories (`.git/`)
- Node.js projects (`package.json`)
- Rust projects (`Cargo.toml`)
- Python projects (`pyproject.toml`, `requirements.txt`, `setup.py`)
- Go projects (`go.mod`)
- Java/Kotlin (`pom.xml`, `build.gradle`)
- C/C++ (`CMakeLists.txt`, `Makefile`)

**Ignored directories:**
- `/tmp`, `/var`, `/etc`, `/usr`
- Home directory root
- System paths

---

## 🔐 Privacy & Data

### Local Storage

All memory is stored locally in `./storage/`:
- `memory.json` — Long-term facts
- `episodic.json` — Recent activity (auto-expires)
- `working.json` — Session context

### Supermemory (Optional)

If configured, memories are synced to Supermemory for:
- Semantic search across all your work
- Persistent cloud backup
- Cross-device access

**Your API key is never stored in memory or sent to the LLM.**

---

## 🛠️ Customization

### Configuration File

Edit `config/default.json`:

```json
{
  "llm": {
    "provider": "openai",
    "model": "gpt-4o-mini",
    "temperature": 0.7
  },
  "monitor": {
    "enabled": true,
    "ignorePatterns": ["node_modules", ".git"]
  },
  "memory": {
    "episodicMaxAge": 3,
    "episodicMaxEvents": 100
  }
}
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | OpenAI API key |
| `GEMINI_API_KEY` | Google Gemini API key |
| `SUPERMEMORY_API_KEY` | Supermemory API key |
| `AI_DEBUG` | Enable debug logging |

---

## 🐛 Troubleshooting

### "AI doesn't know what I was working on"

1. **Check terminal monitoring:**
   ```bash
   ai-monitor status
   ```

2. **Verify shell hook is sourced:**
   ```bash
   grep "zsh-hook" ~/.zshrc
   ```

3. **Check episodic memory:**
   ```bash
   cat storage/episodic.json
   ```

### "Supermemory not storing memories"

1. **Verify API key:**
   ```bash
   ai supermemory
   ```

2. **Test manually:**
   ```bash
   ai supermemory --store "test"
   ```

### "Git diffs not showing"

1. **Ensure you're in a git repo:**
   ```bash
   git status
   ```

2. **Check for uncommitted changes:**
   ```bash
   git diff
   ```

---

## 🤝 Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests
5. Submit a pull request

---

## 📄 License

ISC License — see [LICENSE](LICENSE) for details.

---

## 🙏 Acknowledgments

- [LangChain](https://langchain.com) — Prompt templates and LLM abstraction
- [Supermemory](https://supermemory.ai) — Semantic memory cloud
- [Commander.js](https://github.com/tj/commander.js) — CLI framework
- [Chokidar](https://github.com/paulmillr/chokidar) — File system watcher

---

<p align="center">
  <b>Built with 🧠 by developers who forget what they were working on</b>
</p>
