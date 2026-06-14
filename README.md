# SQL Tabs

Rich desktop SQL client and editor with a Vim mode, query result grids, inline
charts, and Markdown-annotated SQL "documents". Built on Electron.

> **This fork** has been modernized and focused on **PostgreSQL**. It runs on a
> current Electron (31) and Node.js (18+/22), uses the pure-JS `pg` driver (no
> native build step), and adds **autosave / session restore** so open tabs and
> unsaved work survive a crash, freeze, or quit. The other database backends
> from upstream (MySQL, MS SQL, Cassandra, Firebase) have been removed.

## Supported databases
- Sednai **PG-XZ**
- **PostgreSQL**
- **Amazon Redshift** (use a `redshift://` connection string)
- **IVOA TAP / ADQL** services such as the **ESA Gaia archive** — query
  astronomical catalogs over HTTP with ADQL (use `gaia://`, `gaiapre://`,
  `tap://` or `taps://`; see [Gaia / IVOA TAP](#gaia--ivoa-tap-archives) below)
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
git tag v1.3.0
git push origin v1.3.0
```

A tagged run gathers every installer and creates a **draft GitHub Release** with
them attached — review it under *Releases* and click *Publish*. This is the
easiest way to build the macOS and Windows installers without owning those
machines.

| Platform | Installers |
|----------|------------|
| Ubuntu / Debian | `.deb`, `.AppImage` |
| Fedora / RHEL | `.rpm`, `.AppImage` |
| macOS | `.dmg` (Intel x64 + Apple Silicon arm64) |
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

## Gaia / IVOA TAP archives

Besides SQL databases, SQL Tabs can query any
[IVOA **TAP**](https://www.ivoa.net/documents/TAP/) (Table Access Protocol)
service that speaks **ADQL** over HTTP — most notably the **ESA Gaia archive**.
Results are fetched as CSV so values arrive as exact text, which matters because
Gaia `source_id` is a 64-bit integer that JSON's doubles would corrupt.

### Connection strings

| Connection string | Endpoint |
|-------------------|----------|
| `gaia://` | ESA Gaia archive (`gea.esac.esa.int`), anonymous |
| `gaia://<username>` | ESA Gaia archive, **authenticated** (password prompted) |
| `gaiapre://` / `gaiapre://<username>` | ESA Gaia **pre-release** archive (`geapre.esac.esa.int`) |
| `tap://host/path`, `taps://host/path` | any IVOA TAP service (optionally `tap://user@host/path`) |

`gaia://` and `gaiapre://` are shortcuts for the ESA endpoints; for any other
archive give the full host and TAP path, e.g.
`taps://geapre.esac.esa.int/tap-server/tap`.

```adql
--- a few bright Gaia DR3 sources
SELECT TOP 10 source_id, ra, dec, phot_g_mean_mag
FROM gaiadr3.gaia_source
WHERE phot_g_mean_mag < 10
ORDER BY phot_g_mean_mag
```

### Authentication

Authentication mirrors the Postgres flow: put the username in the connection
string, and the app prompts for the password (stored encrypted in
`~/.sqltabs/config.json`, never in the repo). It POSTs to the service's `/login`
endpoint for a session cookie, which is attached to every request. An
authenticated session also exposes your personal `user_<name>` tables (saved /
uploaded results) in `TAP_SCHEMA`.

### Notes specific to ADQL

- **Top-N** uses `SELECT TOP n ...` (not `LIMIT`).
- **String literals use single quotes** — `WHERE flag = 'false'`. Double quotes
  mean *identifiers* in ADQL, so `"false"` is read as a column name.
- **`Ctrl/Cmd+I`** on a table name shows its columns (name, datatype, unit,
  description) from `TAP_SCHEMA`, falling back to a `SELECT TOP 0` probe for
  tables `TAP_SCHEMA` does not describe (e.g. your own `user_<name>` tables).
- **Long-running queries:** the synchronous endpoint is aborted at the service's
  own short limit (an expensive `COUNT`/`JOIN` returns "Job timeout/aborted.").
  Prefix the block with [`--- async`](#sql-documents-block-directives) to run it
  through the TAP **asynchronous** (`/async`) endpoint instead, which queues the
  job server-side with a much longer allowance. `Ctrl/Cmd+B` (Break Execution)
  aborts a running async job.

### Time series (DataLink)

Per-source products such as **epoch photometry** (light curves) and **epoch
radial velocity** are not returned by an ADQL `SELECT` — they are served through
the IVOA **DataLink** protocol. The `--- datalink` block marker bridges the two:
it runs the block's ADQL to collect `source_id`s, then downloads the requested
DataLink product for them and renders the combined result.

```adql
--- datalink epoch_photometry "Gaia DR4_RC3" chart scatter
SELECT TOP 50 source_id
FROM user_dr4rc3.vari_long_period_variable
WHERE score_lpv > 0.9
```

- **Syntax:** `--- datalink <retrieval_type> [release] [render-marker]`
- **`<retrieval_type>`** — e.g. `epoch_photometry`, `epoch_rv` (case-insensitive).
- **`[release]`** — the dataset release token, **quoted if it contains a space**.
  Defaults to `"Gaia DR3"`; the pre-release archive uses e.g. `"Gaia DR4_RC3"`.
- Composes with a render marker, so `--- datalink epoch_photometry "Gaia DR4_RC3"
  chart scatter` plots the light curve.
- **Authentication:** DataLink uses the archive's separate data-server login
  (handled automatically from your connection's saved credentials); proprietary
  releases like DR4 require an authenticated `gaia://<user>` / `gaiapre://<user>`
  connection.
- Sources are fetched individually and combined; a run is capped at 5000 sources
  (narrow the query or split it for more).

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

For TAP/ADQL connections two further prefixes change **how the block is
executed** rather than how it is rendered, so each composes with a render
directive: `--- async` runs via the asynchronous `/async` endpoint (e.g.
`--- async chart line`), and `--- datalink <type> [release]` retrieves a
per-source DataLink product such as epoch photometry (e.g.
`--- datalink epoch_photometry "Gaia DR4_RC3" chart scatter`). See
[Gaia / IVOA TAP](#gaia--ivoa-tap-archives).

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
