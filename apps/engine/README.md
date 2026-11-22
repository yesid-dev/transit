# Transit engine

`GET /measure?measure=punctuality&city=stm&from=2026-11-19&to=2026-11-22` returns
the three punctuality shares and two delay percentiles for an inclusive range of service dates.
Use `early`, `on_time`, `late`, `median_delay`, or `p90_delay` in `measure` to select
one value. The `value` object is keyed by measure ID, with shares from 0 to 1 and signed
delays in seconds. A request with no filters covers the network.

| Optional filter | Meaning |
| --- | --- |
| `line` | GTFS `route_id` |
| `direction` | GTFS `direction_id`, either `0` or `1` |
| `stop` | GTFS `stop_id` |
| `departure` | Scheduled first departure in GTFS service time, such as `07:42:00` or `25:15:00`. Requires `line` and `direction`. Trips sharing the same departure slot contribute together. |
| `hour` | Local clock hour, `0` through `23`, of the scheduled stop departure or its arrival when departure is absent |
| `day_type` | `weekday`, `saturday` or `sunday` of the service date |

The answer includes bilingual `state_text` and `info`, plus `evidence` with the requested dates
and filters, scheduled and classified totals, counts per band, excluded counts by reason,
classified over scheduled, cleaning and method versions, and query milliseconds.
`days_measured` lists valid days in the window, `days_not_measured` lists gaps, and
`days_included` lists the measured days selected by the day-type filter. A partial window
includes a bilingual coverage note. The engine validates `manifest.json` under
`<root>/<provider>/<service-date>/v<cleaning_version>/` and checks the query input file sizes
before reading. Cleaning v5 also checks the alerts file when the manifest lists it.
A missing or invalid manifest, missing required file, or wrong size makes that day a gap.

Values are null when the answer is no live data, not measured, too few to judge, or unknown.
No live data means the cut contains scheduled service only on lines without live data.
Not measured means no valid day contributes, or every eligible stop was affected by a capture
gap. Too few to judge means fewer than 30 classified stop events with at least one observation.
Unknown covers a cut with no match or with no classified event for another reason. Capture
gaps stay in the scheduled total. A measured zero share has its denominator and a zero band count.

`GET /how-we-measure` returns the registry's English and French entries, including
definitions, minimum sample, calculation method and export columns. Add
`format=csv&lang=fr` for one row per measure with French headings or use `lang=en` for
English. CSV includes the evidence and leaves missing values blank.

Use `measure=service_delivered` for trips run, cancelled trips, missing trips,
service hours, and first and last departures. Each share is also available on its own
as `trips_run`, `cancelled_trips`, `missing_trips`, `service_hours`, `first_trip`,
or `last_trip`. These measures use the local hour of the scheduled start for `hour`.
They reject `stop`. First and last trip selections require `line` and `day_type`,
accept `direction`, and use the full service day. A family answer gives each
measure's state in `evidence.measure_states`.

Trip counts include every state. The rate denominator excludes added trips,
trips on routes without live data and capture gaps. The cancellation evidence
includes the estimated median of notice time minus scheduled start and an exact count
of positive offsets. The hours measure and the full family answer require the v4
scheduled stop times file. The first and last departure evidence gives the GTFS time
and scheduled, eligible and run counts for each included date with service.

| Environment variable | Default |
| --- | --- |
| `ENGINE_CLEAN_ROOT` | `./clean-days` |
| `ENGINE_CLEANING_VERSION` | `5` |
| `ENGINE_HOST`, `ENGINE_PORT` | `127.0.0.1`, `8080` |
| `ENGINE_CONCURRENCY` | 2 active queries |
| `ENGINE_QUERY_MEMORY_MIB` | 256 MiB per DuckDB query |
| `ENGINE_QUERY_THREADS` | 1 DuckDB thread per query |
| `ENGINE_QUEUE_SIZE`, `ENGINE_QUEUE_WAIT_MS` | 16 waiting requests, 5,000 ms before timeout |

The service uses one HTTP process. It returns HTTP 503 with `busy, try again` and `Retry-After: 1`
when the queue is full or a wait expires. `X-Engine-Queued` identifies requests admitted to the queue.
DuckDB disk spill is disabled. Set the process or container memory budget separately from the
per-query DuckDB limit to account for HTTP, Python and DuckDB allocations outside the buffer manager.

## Windows local run

Use the repository's [Python pin](../../.python-version). From the repository root in PowerShell,
point the service at a directory with generated clean days.

```powershell
cd apps/engine
uv sync --locked --managed-python
$env:ENGINE_CLEAN_ROOT = (Resolve-Path ./clean-days).Path
uv run --locked transit-engine
```

In a second terminal, run the checks or ask for a day.

```powershell
uv run --locked --managed-python pytest
uv run --locked --managed-python ruff check src tests
uv run --locked --managed-python mypy
Invoke-RestMethod 'http://127.0.0.1:8080/measure?measure=punctuality&city=stm&from=2026-11-19&to=2026-11-19'
```

## VM timing and burst

On the Linux VM, set `END_DATE` to the last day in the contiguous period you want to test. Use
`--spans 1` with one clean day. The burst needs one real clean day per distinct question.

```sh
cd apps/engine
uv sync --locked --managed-python
export ENGINE_CLEAN_ROOT=/srv/transit/clean-days
export END_DATE=2026-11-19
uv run --locked transit-engine
```

In another terminal on the VM, from `apps/engine` with the same `END_DATE`:

```sh
uv run --locked transit-engine-timing --city stm --end-date "$END_DATE" --spans 1 7 30 182 365 --out timing.json
uv run --locked transit-engine-burst --url http://127.0.0.1:8080 --city stm \
  --end-date "$END_DATE" --requests 32 --memory-limit-mib 1024 --out burst.json
```

The timing script sends three network requests per span through `/measure`. It records
the wall time and the engine query time, including file discovery and connection setup.
It exits nonzero on an HTTP error or an incomplete span. Use `--url` to point at another
engine. For a comparison with a larger configuration, set `ENGINE_QUERY_THREADS=4` and
`ENGINE_QUERY_MEMORY_MIB=1908` on the engine before starting it.

The burst reports answered, busy, errors, queued, p50/p95/p99, and the service process's Linux peak
RSS. Queued overlaps with the response outcomes. The run passes when at least one day answers,
every request returns a clean-day answer or explicit busy, the service process stays the same,
and peak RSS stays below `--memory-limit-mib`. Start a fresh service for an isolated peak because
Linux reports the process lifetime high-water mark.

### Audit a clean day

Use `Store.verify` for an explicit full SHA-256 audit. It reads both files and returns false for
an incomplete day or digest mismatch. With the same environment as the engine, this exits
with status 1 when verification fails.

```sh
uv run --locked python -c "from datetime import date; from transit_engine.store import Store; store = Store.from_env(); conn = store.connect(); raise SystemExit(0 if store.verify(conn, 'stm', date.fromisoformat('2026-11-19')) else 1)"
```

### Read from R2

Use the same commands with `ENGINE_CLEAN_ROOT=s3://<bucket>/<prefix>` and
`ENGINE_S3_ENDPOINT=<account-id>.r2.cloudflarestorage.com`. Inject
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and, if applicable, `AWS_SESSION_TOKEN`
using the host's secret mechanism. The credentials need list and read access on the clean prefix.
For a native VM run, install the matching DuckDB `httpfs` extension once as the service user.

```sh
uv run --locked python -c 'import duckdb; duckdb.connect(config={"custom_extension_repository": "https://extensions.duckdb.org"}).execute("INSTALL httpfs")'
```

### Build and run the image on a Linux Docker host

From the repository root, with `END_DATE` set:

```sh
docker build --platform linux/amd64 -t transit-engine:local apps/engine
docker run --rm --memory=1024m -p 127.0.0.1:8080:8080 \
  -e ENGINE_CLEAN_ROOT=/data -v /srv/transit/clean-days:/data:ro transit-engine:local
```

For R2, replace the `/data` mount and its root setting with `--env-file "$ENGINE_ENV_FILE"`,
containing the R2 settings above. The image includes `httpfs`. Run the same timing and burst
commands against the mapped port.

## Later Cloudflare Containers proof

On a Linux Docker host with the deploy authorization, use the repository's pinned Wrangler.
Set `ENGINE_CLEAN_ROOT` and `ENGINE_S3_ENDPOINT` for R2. Set `ENGINE_SECRETS_FILE` to a
secret-manager-provided dotenv file outside the repository with the AWS credentials above.
The Worker forwards requests to a single `standard-1` container.

```sh
bun install --frozen-lockfile
cd apps/engine
node ../../node_modules/wrangler/bin/wrangler.js deploy \
  --var "ENGINE_CLEAN_ROOT:$ENGINE_CLEAN_ROOT" --var "ENGINE_S3_ENDPOINT:$ENGINE_S3_ENDPOINT" \
  --secrets-file "$ENGINE_SECRETS_FILE"
uv sync --locked --managed-python
uv run --locked transit-engine-burst --url "$ENGINE_URL" --city stm \
  --end-date "$END_DATE" --requests 32 --memory-limit-mib 1024 --out cloudflare-burst.json
```

Set `ENGINE_URL` to the deployed Worker URL. For a Cloudflare Access service token, inject
`CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` into the burst client's environment. The hosted
burst measures the public one-day request shape end to end. Use `--url "$ENGINE_URL"`
with the timing command for hosted range requests.
