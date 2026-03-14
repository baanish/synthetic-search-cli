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

`SYNTHETIC_API_KEY` always takes priority over saved config.

### Environment variable (recommended for CI)

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

## API Endpoints

- `POST https://api.synthetic.new/v2/search`
- `GET https://api.synthetic.new/v2/quotas`

## Development

```bash
npm install
npm run test
npm run build
```

Run in dev mode:

```bash
npm run dev -- search "latest llm tooling"
```

## License

MIT
