# SQL Tabs

Rich desktop SQL client and editor with a Vim mode, query result grids, inline
charts, and Markdown-annotated SQL "documents". Built on Electron.

> **This fork** has been modernized and focused on **PostgreSQL**. It runs on a
> current Electron (31) and Node.js (18+/22), uses the pure-JS `pg` driver (no
> native build step), and adds **autosave / session restore** so open tabs and
> unsaved work survive a crash, freeze, or quit. The other database backends
> from upstream (MySQL, MS SQL, Cassandra, Firebase) have been removed.

## Supported databases

- **PostgreSQL**
- **Amazon Redshift** (use a `redshift://` connection string)
- **AlaSQL** — a small in-process SQL engine used for scratch/`about:` tabs

## Supported platforms

- Linux
- macOS

## Features

- Multi-tab SQL editor (Ace) with an optional **Vim** keybinding mode
- Schema-aware **autocompletion**
- Result grids with lazy rendering, sorting, and CSV/JSON export
- **Charts** rendered inline with [c3.js](https://c3js.org) (see below)
- **Cross-tables**, raw **CSV** view, and **Markdown** documentation blocks
- **Object / database info** browser (tables, columns, indexes, constraints,
  functions, triggers, …), compatible with PostgreSQL 10 → current
- Query **history**
- **SSH tunneling** to reach databases behind a bastion host
- **Autosave & session restore** — open tabs and unsaved editor content are
  persisted to `~/.sqltabs/session.json` and restored on the next start

## Running from source

Requires **Node.js 18+** (tested on 22) and npm. No native toolchain is needed.

```bash
git clone git@github.com:Sednai/sqltabs.git
cd sqltabs
npm install        # also compiles the JSX into build/
npm start          # launches the app (dev mode)
```

`npm run compile` rebuilds `build/` after editing files in `src/`
(`npm run compile:watch` to watch).

## Building installers

No native modules are used, so packaging is just Electron + JS — there are no
per-platform native rebuilds. Installers are produced with
[electron-builder](https://www.electron.build) into `dist/`.

**Locally on Fedora** (AppImage + rpm need no extra tooling):

```bash
npm run dist:linux        # AppImage + deb + rpm
# or only the two that need no extra tools:
npx electron-builder --linux AppImage rpm --publish never
```

The **`.AppImage`** builds with no extra setup. Building **`.rpm`** or **`.deb`**
locally on Fedora also needs electron-builder's `fpm` compat libraries (Fedora 43
dropped `libcrypt.so.1`), plus `dpkg` for the deb:

```bash
sudo dnf install libxcrypt-compat dpkg fakeroot
```

The **macOS `.dmg`** can only be built on a Mac. If building rpm/deb locally is
inconvenient, build everything in CI instead (below).

**All platforms via CI** — the included GitHub Actions workflow
([`.github/workflows/build.yml`](.github/workflows/build.yml)) builds Linux
(AppImage + deb + rpm on `ubuntu-latest`), macOS (dmg on `macos-latest`) and
Windows (nsis `.exe` on `windows-latest`). Trigger it from the **Actions** tab
("build-installers" → *Run workflow*) to get the installers as downloadable
**artifacts**, or push a version tag to also publish a release:

```bash
git tag v1.2.0
git push origin v1.2.0
```

A tagged run gathers every installer and creates a **draft GitHub Release** with
them attached — review it under *Releases* and click *Publish*. This is the
easiest way to build the macOS and Windows installers without owning those
machines.

| Platform | Installers |
|----------|------------|
| Ubuntu / Debian | `.deb`, `.AppImage` |
| Fedora / RHEL | `.rpm`, `.AppImage` |
| macOS | `.dmg` |
| Windows | `.exe` (NSIS) |

The macOS dmg is **unsigned** by default (first launch: right-click → *Open*).
For notarized distribution, add an Apple Developer ID certificate and signing
configuration.

## Connecting

Enter a connection string in the tab's connection bar (`Ctrl/Cmd+L`):

```
postgres://user:password@host:5432/dbname
redshift://user:password@host:5439/dbname
```

- A trailing `--- alias` is shown as the tab label, e.g.
  `postgres://localhost/app --- local app`.
- **SSH tunnel:** prefix with an `ssh://` hop separated by `|`:
  `ssh://user@bastion | postgres://user@db-host:5432/dbname`
  (uses `~/.ssh/id_rsa`, or `?identity_file=...` on the ssh part).
- Passwords can be saved (encrypted) in `~/.sqltabs/config.json`.

## SQL documents: block directives

A script is split into blocks separated by lines beginning with `---`. The text
after `---` on that line selects how the block's result is rendered:

| Directive | Renders the result as |
|-----------|-----------------------|
| *(none)* | a normal result table (default) |
| `--- chart <type> [options]` | a **chart** (c3.js) |
| `--- crosstable` | a pivoted cross-table |
| `--- csv` | raw comma-separated values |
| `--- hidden` | nothing (run for side effects) |

You can also embed Markdown anywhere with `/** ... **/` blocks (rendered as
documentation above/below the result).

### Charts

Yes — charts are supported. Start a block with `--- chart <type>`; the **first
column is the x-axis** and each remaining **numeric column is a series**.
`<type>` is any [c3 chart type](https://c3js.org/examples.html): `line`
(default), `spline`, `area`, `area-spline`, `bar`, `scatter`, `pie`, `donut`,
`gauge`, …

```sql
--- chart area-spline
SELECT n, sin(n) AS sinn, n*sin(n) AS nsinn
FROM generate_series(1, 100) n
```

```sql
--- chart donut
/** ## Top 10 relations by size **/
SELECT relname, pg_total_relation_size(oid)
FROM pg_class ORDER BY 2 DESC LIMIT 10
```

More runnable examples live in [`examples/`](examples/).

## Keyboard shortcuts (selection)

| Action | Shortcut |
|--------|----------|
| Run script | `Ctrl/Cmd+R` |
| Execute block | `Ctrl/Cmd+E` |
| Execute all blocks | `Ctrl/Cmd+Shift+E` |
| Auto-format block / all | `Ctrl/Cmd+K` / `Ctrl/Cmd+Shift+K` |
| Object info under cursor | `Ctrl/Cmd+I` |
| Edit connection string | `Ctrl/Cmd+L` |
| Find | `Ctrl/Cmd+F` |
| History | `Ctrl+H` / `Cmd+Y` |
| New / close tab | `Ctrl/Cmd+T` / `Ctrl/Cmd+W` |

## License

GPL-3.0. Original work © Aliaksandr Aliashkevich; see [LICENSE](LICENSE).
