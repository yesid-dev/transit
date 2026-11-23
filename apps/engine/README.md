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
before reading. Cleaning v5 through v9 also check the alerts file when the manifest lists it.
A missing or invalid manifest, missing required file, or wrong size makes that day a gap.

From cleaning v9, punctuality and its ranking counts read `stop_events` directly.
Each stop event carries the trip exclusion reason, route live-data flag and scheduled
start in GTFS service seconds. The provider's declared timezone determines the
scheduled stop hour, and the service date determines the weekday. An overnight
stop keeps its trip's service weekday. Select an older cleaning version with
`ENGINE_CLEANING_VERSION` to query its stop events through the trip join.

`GET /data-health?city=stm&from=2026-11-19&to=2026-11-22` reports each day in the
inclusive range, up to 400 days, without reading Parquet contents. A day is `present`
when `manifest.json` validates for the engine's cleaning version and every file it lists
exists with the recorded byte size, and `missing` otherwise, with `reason` set to
`no_manifest` or `invalid_manifest`. A valid manifest with a listed file missing or a
wrong size makes the day `incomplete`. A receipt with `no_raw_captures` or
`no_schedule_edition` settles a day with no Parquet files. Data health reports
`not_measured` and the receipt reason. The `/measure` evidence maps those dates to
their reasons in `days_not_measured_reasons` and leaves settled dates out of
`days_pending`. Both endpoints exclude settled receipts from the
`X-Transit-Days-Pending` header. Each table is `present`
with its manifest row count, `missing`, or `not_tracked` for alerts when the manifest says
so. A table the manifest lists but the day lacks is `missing` with `file_missing` or
`size_mismatch`. Cleaning v7 adds `prediction_samples` to the reported tables and
cleaning v8 adds the wheelchair accessibility columns to `trip_days` and
`scheduled_stop_times`.

Values are null when the answer is no live data, not measured, too few to judge, or unknown.
No live data means the cut contains scheduled service only on lines without live data.
Not measured means no valid day contributes, or every eligible stop was affected by a capture
gap. Too few to judge means fewer than 30 classified stop events with at least one observation.
Unknown covers a cut with no match or with no classified event for another reason. Capture
gaps stay in the scheduled total. A measured zero share has its denominator and a zero band count.

### Series

Add `group=day` to get one cell per service date, `group=hour` for 24 local clock
hours, `group=day_type` for weekday, Saturday and Sunday, or `group=weekday_hour`
for a 168-cell grid ordered by ISO service weekday (Monday = 1) and local hour
(midnight = 0). For a line measure with direction data, `group=direction` returns
GTFS directions 0 and 1 and a null direction cell when the source has unassigned
records. `group=stop` requires a line and a punctuality measure. It returns one cell
per direction and stop, pooling occurrences across trip patterns. Its `stop_sequence`
is the most frequent scheduled GTFS sequence for that stop in the cut, with ties going
to the smaller sequence. Cells are sorted by direction, representative sequence, and
stop ID. Unknown directions come last. `group=departure` requires a line and a service
delivery measure other than first or last trip. Each cell gives the scheduled, cancelled,
missing and other outcome counts for a direction and scheduled GTFS start, ordered by
direction and service time. Both groups accept a direction filter.
`group=line` groups punctuality measures or `trips_run` by GTFS line across the network.
With a stop cut, it returns punctuality by the lines serving that stop. `group=stop_id`
groups punctuality by stop ID across lines and directions. For this group the response
envelope carries the included dates once for all cells.
Grouped cells use the same sample and evidence rules as the corresponding cuts.

`measure=vehicle_days_in_service&group=vehicle` lists the days in service for each
tracked vehicle. `measure=vehicle_trips_run&vehicle=101&group=line` lists the dated
trips with known lines for one vehicle. Both groups use the same tracking checks as
the `vehicles` family. An empty result carries its state and bilingual explanation.
Their CSV exports include the vehicle number or line ID.

Series accept up to 400 inclusive service dates and support the measure's
usual filters. For example, use
`/measure?measure=punctuality&city=stm&from=2026-11-19&to=2026-11-25&group=weekday_hour`.

Each entry in `cells` has a `key` object with its grouping fields, the registry's
`value` map, bilingual `state_text`, `state`, and `evidence` with the counts,
exclusions and included dates for that cell. Family responses retain their
per-measure states where applicable. Cells with no valid day in scope report
`not_measured` with null values. Measured days can still have thin samples
or empty hours. The response envelope lists overall measured, missing and
included dates, method and cleaning versions, and query time.

Punctuality, service delivery, waiting and scheduled service use the same local time
as their hour filters. Events without a scheduled time have no clock hour. First
and last departures are selected from the full day and assigned to the hour of
the boundary departure. Crowding and observed vehicle time are split at clock-hour
boundaries. Vehicle trips use the scheduled start or first position, and reporting
gaps use the hour of the last sighting before the gap. Alert groups clip published
spans to the tracked local dates or hours and count distinct alerts and versions
within each cell. Each cell calculates percentiles, shares and ratios from its own
histogram or evidence totals. Distinct counts can overlap across cells.

Grouped CSV uses one row per cell and prepends localized grouping columns to the
registry headings. A family export uses JSON objects keyed by measure ID in the
value, unit and state columns. A single measure keeps scalar columns and leaves
missing values blank.

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

Trip counts include every state. Rates use 20 or more known-state trips
(ran, cancelled or missing). Unconfirmed trips, trips on routes without live data,
capture gaps and added trips are reported separately. The evidence includes the
eligible and unconfirmed shares of scheduled trips on lines with live data.
Cancellation lead time is the scheduled start minus the notice time. The evidence
gives its estimated median when the registry's sample floor is met and an exact
count of notices after the scheduled start. The hours measure and the
full family answer require the scheduled stop times file available from v4 onward. The first and last
departure evidence gives the GTFS time and underlying trip counts for each included
date with service.

## Open-data scorecard

Use `measure=open_data_scorecard` for all seven measures or select one measure ID
from the table. The family and the feed measures accept `day_type` in addition to
city and inclusive service dates. Individual vehicle, trip and prediction measures
also accept `line`, `direction`, `stop` and `hour`.

| Measure | Result |
| --- | --- |
| `poll_success` | By feed, valid attempts (`ok`, `empty`, `duplicate`) divided by recorded attempts. Evidence includes counts for every result and the share of attempts marked `empty`. |
| `feed_update_interval` | By feed, median and p90 time between changed publication timestamps on valid polls. Backward timestamps and intervals spanning a gap of over 120 seconds between any two capture attempts are excluded. Failed attempts count when checking for gaps. |
| `feed_age_at_capture` | By feed, median and p90 of capture minus publication time on timestamped `ok`, `empty` and `duplicate` polls. Missing timestamps and negative ages are counted separately. |
| `vehicle_field_completeness` | By field, share of vehicle reporting time carrying it. An explicitly unpublished field has state `not_published` for dates covered by that declaration. |
| `live_trip_coverage` | Share of scheduled trips with a first capture on routes seen in realtime at least once in the selection. Added trips and days with a clean trip marked `capture_gap` are excluded from the rate. Trips on routes never seen have a separate count and share of all scheduled trips. |
| `vehicles_without_trip` | Share of vehicle reporting time without a trip ID, with the count of distinct vehicles reporting without one. |
| `prediction_error` | For 1, 3, 5, 10, 15, 20 and 30-minute horizons, count, median signed error, p90 absolute error and share within ±60 seconds. Values use `vehicle_stopped` samples. `trip_update_reported` counts are evidence and `trip_update_passed` is excluded because the observed time is itself a prediction. Fewer than 30 independent observations suppresses that horizon's statistics. |

Feed-time percentiles use one-second histogram bins through 600 seconds, with
`over_10_minutes` for a percentile that reaches the overflow bin. Capture spacing
sets the shortest update cadence we can resolve. Feeds that update faster appear
to update at the polling interval. Prediction
percentiles use 15-second bins and the ±60-second share includes both boundaries.
Vehicle time uses the same capped tail as crowding. Its hour cut intersects reporting
intervals with the local hour. Coverage selects the scheduled start hour and trips
serving the requested stop. Prediction error selects the observed local hour.

The scorecard prefers the configured cleaning version per day and can use an older
valid version for the measures it supports. Prediction error needs the
`prediction_samples` file added in v7. Each measure reports its dates, versions, counts
and exclusions in evidence. Feed, field and horizon states are under
`dimension_states`. CSV uses one row per measure, with dimensional values and
evidence encoded as JSON cells. Definitions and headers are available in both
languages from `/how-we-measure`.

New clean-day receipts carry the provider declaration's timezone, enabled realtime
feeds and optional `unpublished_vehicle_fields`. For earlier receipts the engine
uses the historical service timezone and has no field-level publication declaration.
An alert history file does not establish the result of individual alert polls.
Cleaning v8 records attempts for declared alert feeds in `feed_polls`, including
archived errors and duplicates recorded only in the capture manifest. The scorecard
groups `i3_alerts` and `service_alerts` under `alerts`. STM JSON carries no feed header,
so its alert polls support poll success and leave publication timing `unknown`.
Declared alert feeds without attempt rows also remain `not_measured`.

## Accessibility

Use `measure=accessibility` for the share of scheduled trips the agency declares
wheelchair accessible (`accessible_trips`) and the share of distinct served stops it
declares accessible (`accessible_stops`). Each measure is also available on its own.
The cut supports `line`, `direction`, `stop`, `hour` and `day_type`. A `stop` cut makes
`accessible_trips` mean trips that serve that stop. A stop uses its declaration on the
latest service date when it matches the cut. A stop or platform can inherit its parent
station's declaration when it has no information of its own.

Evidence gives counts for accessible (1), not accessible (2), no information (0),
and an unpublished column (null). The accessible share divides the accessible count by
the sum of the first three counts. The state is `not_published` when all matching records
have null, `unknown` when there are no matching records, and `not_measured` before v8.
The measure reports the agency's schedule declaration about wheelchair accessibility.

## Rankings

`GET /ranking?kind=line&city=stm&from=2026-11-19&to=2026-11-22` ranks lines
worst first by on-time share. Select another registry measure with `measure`, or use
`kind=stop` or `kind=departure`. A departure groups a line, direction and scheduled
first start in GTFS service time. A missing direction is returned as null. Departure
rankings accept `line` and `direction` cuts. Punctuality ranks use the stop-event
sample of the trips in that departure slot. The `hour`
and `day_type` cuts follow the selected measure. First and last trips rank lines only
and require `day_type`.

Line classes combine GTFS route type with a scheduled service pattern. A majority of
starts in local hours 00:00 through 04:59 makes a line night service. Other lines are
frequent when the average gap between consecutive distinct starts in the same
direction and service date is at most ten minutes in the local 07:00 to 09:00 peak
window on weekdays. Weekend peak headways are used when the requested range contains
no weekday. The remaining lines are regular. The default line list uses the class with the most scheduled trips
among the lines in the cut. Select a class with `class=3:frequent`, or compare all
classes with `class=all`. Stops and departures rank across the network and carry
their contributing classes. Cleaning v6 and later record GTFS route types. Cleaning
versions before v6 show an unknown route type.

The response includes ranked rows, all exclusions within the selected scope, and the
measured and missing dates. Ties use larger samples first, then ID. `limit` limits
ranked rows only, from 1 to 500, and defaults to 100. See the measure registry for the
sample required for each kind of ranking. Share rankings order by the conservative
end of the 95% Wilson interval and show it in `ranking_bound`. The value is the exact
share. The service-hours interval uses an effective sample weighted by scheduled
duration. Stop events on the same trip are dependent, so treat the bounds as a guide.
Percentile bounds show the integer-second histogram rounding range.
Use `format=csv&lang=fr` for French headings or `lang=en` for English.

| Environment variable | Default |
| --- | --- |
| `ENGINE_CLEAN_ROOT` | `./clean-days` |
| `ENGINE_CLEANING_VERSION` | `9` |
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

The timing script sends three requests per span by default. It records
the wall time and the engine query time, including file discovery and connection setup.
It exits nonzero on an HTTP error or an incomplete span. Use `--line` with a GTFS route ID
to measure one line, `--kind line|stop|departure` for a ranking, `--group weekday_hour`
for a grid, and `--measure service_delivered` for service delivered. Use `--url` to
point at another engine.

To time a year locally, copy seven measured v7 days covering all weekdays to a
local source root. Keep their `provider/date/v7` layout. From `apps/engine` on Windows:

```powershell
uv run --locked --managed-python python scripts/repeat_clean_week.py <source-root> <new-output-root> stm 2025-11-22
```

Use a new output directory outside the repository. The script repeats the source
week by weekday, shifts timestamps by the difference between GTFS service anchors,
and regenerates the file identities in every receipt. The resulting year is for
timing only. Point `ENGINE_CLEAN_ROOT` at that output, set
`ENGINE_CLEANING_VERSION=7`, and restart the engine with `ENGINE_QUERY_THREADS`
set to 1, 2, and 4 for comparison. Hold
`ENGINE_QUERY_MEMORY_MIB` at 2048 for the three runs and use `--spans 30 90 365`.

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
For a native VM run, install the locked `httpfs` wheel and register its extension as the service user.
Capture coverage reads the source lag in the clean-day receipt when available. For older
receipts it reads the provider declaration from the repository or the directory named by
`ENGINE_PROVIDER_DECLARATIONS`. The image includes those declarations.

```sh
uv sync --locked --extra r2
uv run --locked --extra r2 python -m transit_engine.install_httpfs
```

### Build and run the image on a Linux Docker host

From the repository root, with `END_DATE` set:

```sh
docker build --platform linux/amd64 -f apps/engine/Dockerfile -t transit-engine:local .
docker run --rm --memory=1024m -p 127.0.0.1:8080:8080 \
  -e ENGINE_CLEAN_ROOT=/data -v /srv/transit/clean-days:/data:ro transit-engine:local
```

For R2, replace the `/data` mount and its root setting with `--env-file "$ENGINE_ENV_FILE"`,
containing the R2 settings above. The image includes `httpfs`. Run the same timing and burst
commands against the mapped port.

## Private Cloudflare Container

Run the **Deploy Transit Engine** workflow from `main` and supply a provider and a measured
service date for the smoke check. GitHub Actions builds the image and deploys the Worker with
the pinned Wrangler. The Worker reads `s3://transit-clean` directly through DuckDB `httpfs`
using the repository's read-only R2 credentials. It forwards authenticated requests to one
`standard-1` container, which sleeps after five idle minutes.

Use the `workers.dev` URL from the workflow with `--url` for timing and burst. Supply
`TRANSIT1_ENGINE_ACCESS_TOKEN` through your secret manager. Both harnesses use it as a
bearer token over HTTPS. The burst needs a complete clean day for each request and uses
`--memory-limit-mib 4096` for `standard-1`.
