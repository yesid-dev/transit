# Transit engine

`GET /network-punctuality?city=stm&date=2026-11-19` answers one provider's network for one local service date.
It reads `manifest.json` under `<root>/<provider>/<service-date>/v<cleaning_version>/` and
checks the SHA-256 and size of each listed Parquet file before querying them.

Each scheduled stop of each non-cancelled trip on a route with live data counts once. A stop with a
non-null delay is early below −60 seconds, on time from −60 through 300 seconds inclusive, and late
above 300 seconds. The response includes the city, inclusive dates, three band counts, classified
and scheduled totals, classified over scheduled, on-time over classified, cleaning versions, method
version, and elapsed query milliseconds.

`not_measured_route_without_live_data` counts scheduled stops excluded from every rate because the
route has no live data. `not_measured_capture_gap` counts scheduled stops with a capture gap.
Those stops stay in the scheduled total so the observed share reflects missed coverage. A day with
a missing or invalid manifest, a missing file, or a checksum mismatch returns a `not measured`
message, null counts and shares, and an empty version list.
A present day with no observations still reports its scheduled count.

| Environment variable | Default |
| --- | --- |
| `ENGINE_CLEAN_ROOT` | `./clean-days` |
| `ENGINE_CLEANING_VERSION` | `3` |
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
Invoke-RestMethod 'http://127.0.0.1:8080/network-punctuality?city=stm&date=2026-11-19'
```

## VM timing and burst

On the Linux VM, set `END_DATE` to the last day in the contiguous period you want to test. Use
`--spans 1` with one clean day. The burst needs one real clean day per distinct question.

```sh
cd apps/engine
uv sync --locked --managed-python
export ENGINE_CLEAN_ROOT=/srv/transit/clean-days
export END_DATE=2026-11-19
uv run --locked transit-engine-timing --city stm --end-date "$END_DATE" --spans 1 7 30 182 365 --out timing.json
uv run --locked transit-engine
```

In another terminal on the VM, from `apps/engine` with the same `END_DATE`:

```sh
uv run --locked transit-engine-burst --url http://127.0.0.1:8080 --city stm \
  --end-date "$END_DATE" --requests 32 --memory-limit-mib 1024 --out burst.json
```

The timing script repeats the laptop benchmark's network bands, per-day trend and hour-by-weekday
grid three times for each span. It records the production one-day query separately, including file
discovery and connection setup. Range results include separate discovery time and first, best and
individual query times. A missing day marks its span incomplete and produces a nonzero exit.
Use `--timezone` when the provider's service timezone differs from `America/Toronto`. For a comparison
with the laptop's larger configuration, set `ENGINE_QUERY_THREADS=4` and `ENGINE_QUERY_MEMORY_MIB=1908`
(approximately 2 GB) for the timing command.

The burst reports answered, busy, errors, queued, p50/p95/p99, and the service process's Linux peak
RSS. Queued overlaps with the response outcomes. The run passes when at least one day answers,
every request returns a clean-day answer or explicit busy, the service process stays the same,
and peak RSS stays below `--memory-limit-mib`. Start a fresh service for an isolated peak because
Linux reports the process lifetime high-water mark.

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
docker run --rm --memory=1024m \
  -e ENGINE_CLEAN_ROOT=/data -v /srv/transit/clean-days:/data:ro -v "$PWD:/results" \
  transit-engine:local transit-engine-timing --city stm --end-date "$END_DATE" \
  --spans 1 7 30 --out /results/timing.json
```

For R2, replace the `/data` mount and its root setting with `--env-file "$ENGINE_ENV_FILE"`,
containing the R2 settings above. The image includes `httpfs`. Run the same burst command against
the mapped port.

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
burst measures the public one-day request shape end to end. Range timings use the timing command
inside the same image on a Docker host.
