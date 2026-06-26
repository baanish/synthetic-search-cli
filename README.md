# synthetic-search

A user-facing CLI for Synthetic web search, quotas, and local credential management.

## Features

- Search the public web with Synthetic (`/v2/search`)
- View account usage and limits (`/v2/quotas`)
- Interactive local auth setup (`auth login` / `auth logout` / `auth status`)
- Readable terminal output by default
- `--json` output mode for scripts and automation
- Tolerant JSON parsing for malformed control characters in API responses

## Requirements

- Node.js 18+
- Synthetic API key

## Installation

```bash
npm install -g synthetic-search
```

Or run directly with `npx`:

```bash
npx -y synthetic-search --help
```

## Authentication

A key saved with `auth login` takes priority over the `SYNTHETIC_API_KEY`
environment variable. Run `auth logout` to fall back to the environment variable.

### Environment variable (recommended for CI)

Use this when no key is saved locally — for example in CI:

```bash
export SYNTHETIC_API_KEY=your_api_key_here
```

### Saved local config

```bash
synthetic-search auth login
```

This validates the key via `GET /v2/quotas` before saving.

Skip validation:

```bash
synthetic-search auth login --no-validate
```

Check status:

```bash
synthetic-search auth status
```

Remove saved key:

```bash
synthetic-search auth logout
synthetic-search auth logout --force
```

## Usage

### Search

Root command and subcommand are equivalent:

```bash
synthetic-search latest model context protocol news
synthetic-search search latest model context protocol news
```

Read query from piped stdin:

```bash
echo "latest ai safety research" | synthetic-search search
```

JSON output:

```bash
synthetic-search search "latest mcp updates" --json
```

Client-side result limit:

```bash
synthetic-search search "latest mcp updates" --limit 2
```

### Quotas

```bash
synthetic-search quotas
synthetic-search quotas --json
```

Quotas are reported per bucket. The **search (hourly)** bucket — the limit that
actually constrains searches — is shown first, followed by the account
**subscription** bucket:

```
Search (hourly):
  Limit: 250
  Requests used: 38
  Remaining: 212
  Renews at: 2026-06-25T21:00:02.537Z

Subscription:
  Limit: 750
  Requests used: 0
  Remaining: 750
  Renews at: 2026-06-26T01:49:17.537Z
```

`--json` emits `{ "buckets": [ … ] }` with `key`, `label`, `limit`,
`requestsUsed`, `remaining`, and `renewsAt` for each bucket.

### Version

```bash
synthetic-search --version
```

## Security

- A key saved with `auth login` is written to the local config file with
  owner-only (`0600`) permissions; a file left looser by an older version is
  tightened the next time the CLI opens it (with a warning if it cannot be).
- Untrusted text printed to the terminal — search results, quota fields, and
  error messages (including Commander usage errors) — is sanitized of terminal
  escape sequences, so a result or upstream error cannot manipulate your
  terminal. `--json` output is escaped to stay terminal-safe too.
- Upstream API error bodies are redacted of the active key / bearer-token-like
  material before being shown or logged.
- Response bodies and piped stdin are read with size bounds to prevent a hostile
  upstream or an unbounded pipe from exhausting memory.

## API Endpoints

- `POST https://api.synthetic.new/v2/search`
- `GET https://api.synthetic.new/v2/quotas`

See the [Synthetic API docs](https://dev.synthetic.new/docs/api/overview) for the
full schema.

## Development

```bash
npm install
npm run typecheck   # type-check src, tests, and scripts (no emit)
npm run test        # run the node:test suite
npm run build       # compile to dist/
npm run fuzz        # sandboxed CLI fuzzer (no network, no real config)
```

Run in dev mode:

```bash
npm run dev -- search "latest llm tooling"
```

Continuous integration runs typecheck, test, and build on Node 18, 20, and 22
(see [`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

## License

MIT
