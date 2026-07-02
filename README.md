# Master of Knowledge AGY

An Obsidian plugin fork focused on Antigravity CLI OAuth agent workflows.

This fork disables Google Gemini API key setup, File Search upload/sync, and API-key chat. It uses your local `agy` CLI subscription/OAuth session and local vault context folders instead.

## What This Fork Does

- Opens an Agent-first dashboard inside Obsidian.
- Runs Antigravity/AGY from the Agent tab with the current vault path passed via `--add-dir`.
- Loads relevant excerpts from selected local context folders into the Agent prompt.
- Keeps generated notes, graph artifacts, and logs under `_omg`.
- Supports Apply, Copy, Create Note, Select Note, and Save to `_omg` actions.
- Builds a local graph from Obsidian wikilinks and tags in selected context folders.

## What Is Disabled

- Google Gemini API key input and verification.
- Gemini File Search upload/sync.
- API-key Chat tab.
- Gemini API budget tracking.

Legacy Gemini settings remain in the data model only for compatibility with existing plugin data. The plugin clears `apiKey` on load and does not call Google APIs from the Agent-only path.

## Installation

1. Clone this repository into your vault plugin folder:

```bash
cd /path/to/your/vault/.obsidian/plugins
git clone https://github.com/flytothesky23/omg-search.git master-of-knowledge-agy
cd master-of-knowledge-agy
```

2. Build the plugin:

```bash
npm install
npm run build
```

3. Enable `Master of Knowledge AGY` in Obsidian community plugin settings.

## Setup

1. Install and log in to Antigravity CLI so `agy` works in your terminal.
2. Open Obsidian Settings > Master of Knowledge AGY.
3. Set `Antigravity CLI Path`.
   - Try `Auto-detect` first.
   - If Obsidian cannot find `agy`, set the full path, for example `/Users/you/.local/bin/agy`.
4. Choose `Context Folders`.
   - Notes in these folders stay local.
   - Relevant excerpts are added to Agent prompts.
5. Open the dashboard and run work from the Agent tab.

## Notes

- The plugin does not upload notes to Gemini File Search.
- Antigravity CLI must have its own OAuth/subscription session already configured.
- If Obsidian is opened from Finder or Dock, it may not inherit your shell PATH. Use the full CLI path if Auto-detect fails.
- Agent runs are logged under `_omg/logs`.
- Generated Agent notes default to `_omg/agent`.

## Development

```bash
npm install
npm run dev
npm run build
```

## License

MIT

## Credits

Forked from [`reallygood83/omg-search`](https://github.com/reallygood83/omg-search).
