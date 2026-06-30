# AGENTS.md

## Cursor Cloud specific instructions

This repo is `synthetic-search`, a Node.js (ESM, `>=18`) TypeScript CLI that wraps the
hosted Synthetic web-search API (`https://api.synthetic.new`). There is no backend, database,
or frontend to stand up — it is a single command-line binary.

Standard commands live in `package.json` (`build`, `dev`, `start`, `test`) and `README.md`.
Notes that are not obvious from those files:

- `npm install` automatically runs the `prepare` script (`npm run build` → `tsc`), so a clean
  install also produces `dist/`. The update script already runs install on startup.
- `npm test` (`tsx --test test/*.test.ts`) runs fully offline: tests inject a mock `fetch` and
  a temp config dir, so no API key or network is needed.
- There is no linter configured. `npm run build` (`tsc` strict) is the type-check / static gate.
- Live `search` and `quotas` (and `auth login` validation / `auth status`) call the real
  Synthetic API and require `SYNTHETIC_API_KEY`. In Cursor Cloud this is provided as a secret
  and injected into the environment, so live commands work without `auth login`.
  Example: `node dist/index.js search "model context protocol" --limit 2`.
- `auth login`/`auth logout` are interactive (TTY prompts) and persist a key locally via `conf`;
  `SYNTHETIC_API_KEY` always takes priority over saved config.
- Run the CLI in dev with `npm run dev -- search "<query>"` (note the `--` before args).
