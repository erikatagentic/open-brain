<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/banner-dark.png">
  <img alt="open-brain: A memory for AI coding agents, kept in one local file." src=".github/banner-light.png">
</picture>

# open-brain

A memory for AI coding agents: a small MCP server that saves notes to one local file and finds them again by keyword.

[More of my work on erikhernal.com](https://erikhernal.com/?utm_source=github)

## The problem

A coding agent forgets everything when the session ends. Tomorrow it'll repeat the mistake you corrected today, or ask you again about something you already decided.

My own agents save what they learn to a memory like this one and search it at the start of every session. This repo is the small local version of that setup.

## What it does

- Six tools over MCP: `brain_save`, `brain_search`, `brain_recent`, `brain_stats`, `brain_update_project`, `brain_delete`.
- Saves to one SQLite file on your machine. It needs no database server and no API key, and it never touches the network.
- Keyword search ranked by BM25, with an exact-phrase match on top, so a pasted error string lands first.
- `SUPERSEDES <id>` at the start of a note archives the note it replaces, so old answers stop coming back.
- A `state_key` (like `config:theme`) holds a current value. Saving a new value archives the old one.
- A note can carry a project name, and search can stay inside one project. Pass `global` as the project to get only the notes that have none.
- Refuses a second note with the same title inside 24 hours, so a retry can't save the same thing twice. That only covers a title you pass in: a note saved without one gets its title from its first line, and that one isn't checked.
- Deletes by full id or a unique id prefix, and refuses a prefix that matches more than one note.

Search here matches the words you type (with simple stemming, so "deploying" finds "deploy"). It doesn't match by meaning: ask for "cache TTL" and you'll find the note that says "cache TTL", and miss one that only says "expiry time". The private version this came from adds vector search on Postgres for that.

## Run it yourself

You need Node 22.13 or newer, because it uses Node's built-in SQLite.

```sh
git clone https://github.com/erikatagentic/open-brain.git
cd open-brain
npm install
npm run build
npm test
```

Then add it to your MCP client. For Claude Code:

```sh
claude mcp add open-brain node /path/to/open-brain/dist/index.js
```

For other clients, [examples/mcp-config.json](examples/mcp-config.json) shows the usual JSON shape. There are two optional settings:

| Setting | What it does | Default |
|---|---|---|
| `OPEN_BRAIN_DB` | Where the data file lives | `~/.open-brain/brain.sqlite3` |
| `OPEN_BRAIN_SOURCE` | Written to each note's source field | `mcp` |

To try it, ask your agent to "save a note that the staging server restarts at 2am". Then open a new session and ask it to search the brain for "staging restart".

`node scripts/smoke.mjs` starts the server the way a client would and runs a save and a search over stdio.

## One real result

State keys keep one current value per key. The test at [test/brain.test.mjs line 102](test/brain.test.mjs#L102) saves the theme as light, then as dark under the same key, and checks that search only returns dark. The test runs on a fixed clock, so this is the same sequence run by hand:

```text
Saved: "Theme is light" (e663af49-c071-4cbd-8e5f-05dbb4cfd22c) at 2026-11-26T01:50:06.537Z
State key config:theme: first value
Saved: "Theme is dark" (ecd1a42b-f3fc-499b-bbcf-e6cc857bd79b) at 2026-11-26T01:50:06.541Z
State key config:theme: replaced 1 earlier value(s): e663af49-c071-4cbd-8e5f-05dbb4cfd22c

brain_search "app theme":
1. **Theme is dark** (thought, state:config:theme, global, exact phrase)
   id: ecd1a42b-f3fc-499b-bbcf-e6cc857bd79b
   The app theme is dark.
   Tags: none | 2026-11-26
```

The light note is still in the file, marked archived and pointing at the note that replaced it. It just doesn't come back in search.

## How it's put together

| File | What's in it |
|---|---|
| [src/server.ts](src/server.ts) | The six MCP tools and their argument schemas |
| [src/tools.ts](src/tools.ts) | What each tool does, with no MCP or SQL in it |
| [src/store.ts](src/store.ts) | The `Store` interface and the SQLite version of it |
| [src/ranking.ts](src/ranking.ts) | Query parsing, the phrase rule and the score |
| [src/supersede.ts](src/supersede.ts) | Reading the ids after `SUPERSEDES` |

The tools only talk to the `Store` interface, so a different backend only has to implement that.

## Where it came from

Pulled out of a private repo on 2026-11-26. The history stays private because it holds client data. The sample data is made up.

## Contact

erik@erikhernal.com

## License

MIT. See [LICENSE](LICENSE).
