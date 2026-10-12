<!-- generated-by: init-project-docs · verified: 2026-10-12 · commit: 84118ac -->
# CLI Panel

Single-page control panel for AI coding CLIs on a Linux box — it edits the *host's* real
config (`~/.local/bin` launchers, `~/.claude/settings.json`, `~/.codex/`), not a private store.
Node stdlib HTTP server, no framework; Vue 3 global build on the frontend.

## Rules

- **Every non-GET `/api/*` request must send `X-Requested-With: cli-panel`.** Enforced centrally
  in `server.js` (returns 403 before routing). Check: curl a write route without the header.
  Gate: code review — the check lives in one place, so new routes get it for free; do not re-add per-route.
- **Writes are confined to `WRITABLE_ROOTS` in `lib/util.js`.** Anything outside
  (`~/.local/bin/`, `~/.codex/`, `~/.claude/settings.json`, `~/.claude/statusline.py`,
  `~/.config/cli-panel/keys/`) must go through `isWritable()`. Check: `git grep isWritable`.
  Gate: code review.
- **Never commit `data/`.** It holds `auth.json` (password hash), `store.json`, live sessions and
  config backups; `.gitignore` covers it. Check: `git status --short` shows no `data/` path. Gate: CI.
- **Frontend calls the API only through the `api()` helper** in `public/app.js` (it injects the CSRF
  header and handles 401). Check: `git grep "fetch(" public/app.js` — only the helper may appear. Gate: code review.
- **Export→import must restore launcher scripts and config files byte-for-byte.** The bundle carries
  each launcher's raw `text` precisely because hand-written scripts cannot be regenerated. Check: run
  the round-trip in `docs/runbooks/`. Gate: e2e.
- **Any path derived from user input must be validated before it reaches the filesystem.** The bundle
  import takes `provider.id`, catalog `file`, and skill `targets` straight from JSON — validate ids
  with `RE.id` / `RE.cmd`, filenames against a strict pattern, and `targets` against `skills.DIRS` keys.
  Check: `git grep "path.join" lib/backup_bundle.js` and confirm each call site has a guard above it.
  Gate: code review.

## Gotchas (not derivable from the code at a glance)

- `claude.render(form, prov)` takes **two** args — the provider object is required for `prov.id`/`prov.name`.
  Callers must resolve it from the store first.
- Launchers come in two shapes: panel-managed (carry the `MARKER` comment + `# provider:` line, so they
  can be re-rendered) and **hand-written** (no marker → no provider → `claude.normalize()` rejects them).
  Only the raw script text round-trips for the latter.
- `codex.writeProfile()` is **async**; `claude.render()` and `memory.saveRule()` are sync.
- `memory.saveRule()` can only write rule files that **already exist** on this machine — restoring a
  snapshot onto a fresh host skips project rules. `importBundle()` reports these in `skipped`.
- `claude.scan()` only recognises managed Claude launchers. The bundle therefore walks `~/.local/bin`
  itself to also catch **alias scripts** and **codex launchers**, including hand-written ones with no
  `MARKER` (matched by their `exec codex -p <profile>` line).
- `codex.writeProfile()` validates against the *live* `~/.codex/config.toml` by invoking the `codex`
  binary, so the bundle must restore `config.toml` (and the catalog JSONs) **before** profiles — order
  matters, not just presence.
- A snapshot contains every API key and every skill body in cleartext — treat an exported `.json` as a
  secret. It is also ~1.7 MB, so `/api/system/import` gets a raised body limit. Calling
  `importBundle()` directly proves nothing about whether the endpoint works; run the real HTTP
  round-trip in `docs/runbooks/`.
- Config backups are named `<stamp>__<url-encoded-path>` under `data/backups/`; `readBackup()` re-encodes
  `/` before validating, so paths must not be pre-decoded.
- Vue's global build is served from `node_modules` at `/vue.js`, which forces `unsafe-eval` in the CSP.

## Commands

- Run: `node server.js` (defaults `PORT=9099 HOST=0.0.0.0`); in production it runs under pm2 as `cli-panel`.
- One-time password: printed at first boot and written to `data/INITIAL_PASSWORD.txt`.
- `CLI_PANEL_DATA=<dir>` relocates all runtime state — use it to test imports without touching real data.

Docs: GLOSSARY.md, docs/architecture/, docs/adr/, docs/incidents/, docs/runbooks/ — load on demand.
