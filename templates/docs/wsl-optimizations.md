# WSL2 / agentic-development optimizations

Two harness-managed, re-runnable features that keep recursive work cheap on a
10 GB / 10 CPU WSL2 box while staying safe outside it:

1. **Ignore-aware search** — a canonical `.ignore` plus `scripts/agent-search.sh`
   so recursive discovery never walks `node_modules`, `.git`, or build output.
2. **RAM-backed build/cache storage** — `scripts/setup-tmpfs.sh` mounts a tmpfs
   and points cache/build env vars at it.

Both are scripts/config/docs only; neither touches application source.

## 1. Ignore-aware search

### The canonical ignore file (`.ignore`)

`.ignore` is read by ripgrep and fd (git does **not** read it — `.gitignore`
stays the project's own file and the harness never writes it). `agent-harness
update` merges a harness-managed begin/end block listing the high-cost trees:

```
node_modules/ .git/ .venv/ venv/ __pycache__/ .mypy_cache/ .pytest_cache/
target/ dist/ build/ .next/ .nuxt/ coverage/ .gradle/ .cargo/ vendor/
.terraform/ tmp/ .cache/
```

Project entries outside the markers are preserved; the managed block is replaced
in place, so re-running `update` never duplicates or truncates anything.

### `scripts/agent-search.sh`

A thin ripgrep wrapper that:

- relies on the default ignore files and **never** passes `--no-ignore` or
  `--unrestricted` (it refuses those flags, and `--hidden`, outright);
- excludes lockfiles, minified bundles, source maps, and oversized files via
  `--max-columns` / `--max-filesize`;
- supports `--files` for cheap discovery with no content reads;
- caps output (default 200 lines; `--limit N` / `AGENT_SEARCH_LIMIT`).

```bash
scripts/agent-search.sh --files                 # candidate files, no content read
scripts/agent-search.sh -g '*.ts' 'interface Foo'
scripts/agent-search.sh --limit 50 'TODO'
```

### When to use `git grep` instead

For a **symbol search over tracked files** (where you want the repo's definition
of the file set and nothing generated or untracked), `git grep` reads the git
index and searches tracked files only — no ignore-file dependence, so it is the
deterministic choice for "where is this symbol defined":

```bash
git grep -n 'functionName' -- '*.ts' '*.tsx'   # tracked files only, reads the index
git grep -l 'SymbolName'                       # list matching tracked files
```

Rule of thumb:

- `git grep` — tracked-source symbol search; the index already knows the files
  and ignores are irrelevant. Prefer it for "where is this defined".
- `scripts/agent-search.sh` (rg) — content search that must also see untracked
  files while still honouring the canonical ignores; best for "what changed
  locally / what's generated". On small warm trees raw `rg` is often the fastest
  of all; `git grep` wins on large trees where tracked-only traversal pays off.
- Never `rg --no-ignore` / `rg -u` in an agent workspace — it walks `node_modules`
  and build trees and floods both time and context.

No harness agent/tool config forces `--no-ignore`; if a local wrapper does,
remove it and rely on `.ignore` + explicit `-g` globs.

## 2. RAM-backed build/cache storage

`scripts/setup-tmpfs.sh` mounts a single tmpfs root (default `/mnt/ramdisk`)
sized 25–40 % of WSL RAM (default 30 %), then exports cache/build env vars for
**only the toolchains present**:

| Toolchain | Env |
| --- | --- |
| Python | `PIP_CACHE_DIR` |
| npm | `npm_config_cache` |
| pnpm | `PNPM_STORE_DIR` |
| Yarn | `YARN_CACHE_FOLDER` |
| Cargo | `CARGO_TARGET_DIR` |
| Go | `GOCACHE` |
| Gradle | `GRADLE_USER_HOME` |
| ccache / sccache | `CCACHE_DIR` / `SCCACHE_DIR`, `RUSTC_WRAPPER=sccache` |

```bash
scripts/setup-tmpfs.sh up          # mount + write env (idempotent)
eval "$(scripts/setup-tmpfs.sh env)"
scripts/setup-tmpfs.sh status
scripts/setup-tmpfs.sh install     # persist: ~/.bashrc hook + systemd --user unit
scripts/setup-tmpfs.sh down        # unmount + drop the env file
scripts/setup-tmpfs.sh uninstall   # down + remove unit + hook
```

- **Idempotent**: `up` is a no-op mount when the tmpfs is already mounted.
- **No-op outside WSL**: every action detects WSL (override with
  `AGENT_TMPFS_FORCE=1`).
- **Persisted per boot / per shell**: `install` writes an idempotent managed
  block into `~/.bashrc` (which runs `ensure` and sources the env file) and, when
  available, a `systemd --user` unit. `ensure` is the quiet variant the hook uses.
- **Overrides**: `AGENT_RAMDISK`, `AGENT_TMPFS_PERCENT` (clamped 25–40),
  `AGENT_TMPFS_CONFIG`, `AGENT_TMPFS_DRY_RUN=1`.

### Volatility warning

tmpfs lives in RAM. A reboot, an OOM kill, a WSL restart, or `down` **erases**
it. Only **caches and build artifacts** belong there — **never** source code,
databases, secrets, or git state. `down`/`uninstall` remove the env file so
new shells fall back to the default on-disk caches.
