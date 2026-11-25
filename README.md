# Transit

[![web](https://github.com/yesid-dev/transit/actions/workflows/web.yml/badge.svg?branch=main)](https://github.com/yesid-dev/transit/actions/workflows/web.yml)

Transit is an independent dashboard for bus and metro service in Montréal (STM)
and Ottawa (OC Transpo). It captures GTFS and GTFS-Realtime feeds, normalizes
them in PostgreSQL and publishes versioned JSON snapshots that the web app
reads. When an agency doesn't publish a value, the dashboard shows it as
unknown instead of estimating it.

Live at [transit.yesid.dev](https://transit.yesid.dev).

## Stack

| Path | What it does | Built with |
| --- | --- | --- |
| `apps/db` | Captures feeds, normalizes them, computes daily rollups and publishes snapshots | Python, PostgreSQL, SQLAlchemy, Alembic, uv |
| `apps/data-proxy` | Serves the published snapshots from R2 | Cloudflare Workers |
| `apps/web` | The public dashboard; it reads snapshots and never touches the database | SvelteKit 3, Svelte 5, Tailwind CSS 4, MapLibre GL, LayerChart, Cloudflare Workers |

Bun workspaces and Turborepo run the JavaScript apps. Design tokens, motion and
shared UI come from pinned
[yesid.design](https://github.com/yesid-dev/yesid.design) releases.

## How it works

- **Providers are configuration.** Each agency is one file in
  [apps/db/config/providers](apps/db/config/providers): feeds and their capture
  cadence, map bounds and framing, basemap, the lines that publish no live data
  (`lines_without_live_data`) and how late its live feed arrives
  (`live_source_lag_seconds`). Its `public` block decides whether and how the
  dashboard shows it.
- **Live capture.** Two realtime workers, one per provider, poll each feed at its
  declared cadence: vehicle positions every 20 seconds for STM and OC Transpo;
  STM capture is aligned two seconds after its feed rebuilds. Trip updates
  run every 30 seconds; STM service alerts every 5 minutes. OC Transpo
  publishes no alerts feed.
- **Live publication.** Each cycle rebuilds only the live files whose input
  feeds were captured again, then rewrites the manifest last. Live files are
  cached for 20 seconds, and the web app refetches when that cache expires.
- **Freshness on screen.** Live age comes from vehicle positions and trip
  updates; alerts show their own "checked" time. Estimated positions are
  opt-in. They move each vehicle along its route at its reported speed for a
  limited time (70 seconds for STM, longer for a provider with source lag),
  never past a next stop ahead of it, and a vehicle shows as Not reporting
  after a cutoff that also grows by the provider's source lag.
- **Map.** MapLibre draws a per-provider [Protomaps](https://protomaps.com)
  basemap that the [refresh-basemap](.github/workflows/refresh-basemap.yml)
  workflow rebuilds monthly and publishes beside the snapshots.
- **Status colours.** Transport status takes the yesid.design status tokens:
  on time is the page's ink, early is blue, and late and severe share red,
  told apart by shape and word (late ▲, severe ◆). On the live map a severe
  vehicle carries its ◆ at every zoom and the other status badges appear from
  zoom 13; the legend states each status's exact minutes. Interface feedback
  that is not transport status, such as Live, failed or stale, uses the kit's
  signal colours instead;
  [statusTokenOwnership.test.ts](apps/web/src/lib/styles/statusTokenOwnership.test.ts)
  enforces the split. In forced-colours mode, SVG status marks take the system
  ink, and shape, position and the legend glyphs carry the status.
- **Site shell.** The menu has four groups: Now, Explore, Rankings and reports,
  and About the data. The footer's top edge is the kit's hazard strip.

[GLOSSARY.md](GLOSSARY.md) defines the terms used in the code and the UI, such
as Live age, Estimated position and Silent trip.

## Quickstart

Install Node from [.nvmrc](.nvmrc) and Bun from [.bun-version](.bun-version), then:

```sh
git clone https://github.com/yesid-dev/transit.git
cd transit
bun install --frozen-lockfile
bun run dev
```

Open http://localhost:5173. The dev server reads the public snapshots through a
proxy, so it needs an internet connection but no database, API keys or
Cloudflare account.

## Documentation

- [CONTRIBUTING.md](CONTRIBUTING.md) covers checks, browser tests and the Python
  pipeline.
- The
  [Architecture wiki](https://yesid-dev.notion.site/3663e8630690815b927dea4888252234?v=4093e8630690803dbdba000c6dfd9439)
  documents how the system is built, tested, deployed and operated.

## Admin deployment

Dispatch from main to build and deploy a selected SHA or branch immediately,
without running tests or waiting for CI. Targets are `web` (default), `data-proxy`,
or `both`; the job summary records the deployed SHA and Worker version per target.
Production deployments share a non-cancelling lock.

```sh
gh workflow run deploy-now.yml -R yesid-dev/transit --ref main -f ref=<sha> -f target=web
```

For VM workers, use the existing [worker-only rollout runbook](https://app.notion.com/p/40e3e8630690813a80eddf5efc7752bb),
including its documented Compose activation command and host preconditions.

### Private raw capture on the Linux VM

The capture unit takes one provider ID, polls its enabled feeds, and writes
original responses to the private raw bucket. It uses no PostgreSQL connection.
Keep the provider inactive and hidden while validating Gatineau.

From a clean checkout of the approved capture revision, with the VM clock
synchronized, prepare the root-owned systemd environment files:

~~~sh
timedatectl show --property=NTPSynchronized --value
sudo install -d -m 0750 /etc/transit-capture
sudoedit /etc/transit-capture/r2-write.env
sudoedit /etc/transit-capture/sto.env
sudo chown root:root /etc/transit-capture/r2-write.env /etc/transit-capture/sto.env
sudo chmod 0600 /etc/transit-capture/r2-write.env /etc/transit-capture/sto.env
~~~

- `r2-write.env` takes `BRONZE_STORAGE_BACKEND` (S3),
  `BRONZE_S3_ENDPOINT`, `BRONZE_S3_BUCKET` (the private raw bucket),
  `BRONZE_S3_ACCESS_KEY`, `BRONZE_S3_SECRET_KEY`, and optionally
  `BRONZE_S3_REGION`.
- `sto.env` takes `STO_PUBLIC_KEY` and `STO_PRIVATE_KEY`. Optional URL
  overrides are `STO_STATIC_GTFS_URL`, `STO_RT_TRIP_UPDATES_URL`,
  `STO_RT_VEHICLE_POSITIONS_URL`, and `STO_SERVICE_ALERTS_URL`.
  Keep the registered key with its owner.

Install and start the unit after the clock reports `yes`:

~~~sh
sudo install -m 0644 apps/db/ops/linux/transit-capture@.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo bash apps/db/ops/linux/update-capture.sh HEAD sto
sudo systemctl enable --now transit-capture@sto.service
sudo journalctl -u transit-capture@sto.service -n 30 --no-pager
~~~

`update-capture.sh` stages a locked release, validates configuration without
fetching feeds, then restarts the listed instances that were running. Pass all
running city instances when updating their shared release. Re-run it with the
previous approved revision and the same cities to roll back an update. To stop
the initial rollout, run `sudo systemctl disable --now transit-capture@sto.service`.
Preserve the raw objects and the rolling download state under
`/var/lib/transit-capture-sto/` in either case.

**Raw Capture Freshness** checks the private bucket every 30 minutes for each
enabled feed in a provider manifest with `capture_enabled: true`. It uses the
capture timestamp in the newest raw key. Static feeds are late after 1.5 times
their polling interval (36 hours for the daily schedule). The outside alert
marks realtime feeds late after three polling intervals, with a 15-minute
minimum. The VM heartbeat uses three realtime polling intervals with a
one-minute minimum (90 seconds for Gatineau trips and positions). The
workflow reports late, missing and unavailable feeds through the existing
pipeline-alert GitHub issue channel. It mentions Yesito on the first failure,
keeps one issue open during the incident and closes it on recovery.

For planned maintenance, disable **Raw Capture Freshness** in GitHub Actions
and re-enable it when capture resumes. An open issue stays in place until the
next successful check. To check by hand from the repository root, set
`BRONZE_STORAGE_BACKEND=s3` and the read-only `BRONZE_S3_*` values in your
environment and run:

~~~sh
uv run --project apps/db --managed-python --locked python -m transit_ops.capture_freshness
~~~

To fetch one sample per feed and see counts, sizes and prospective raw keys,
run the following from the repository root with the feed variables already
provided through your environment. Use the dry run before the service starts
or after stopping it and waiting a full download window (10 minutes for STO).

~~~sh
uv run --project apps/db --managed-python --locked python -m transit_ops.raw_capture sto --dry-run
~~~

For a private clean-day check, select `sto` explicitly in **Clean service days**.
Its output is confined to the job's temporary directory. To keep the tables
for inspection, run `transit-ops clean-days --provider sto --from YYYY-MM-DD
--to YYYY-MM-DD --source s3://transit-raw --dest /path/to/private-clean` with
the raw read environment. Use `python -m transit_ops.live.playback sto
--source s3://transit-raw --inspect` with that same read environment to check
which realtime feeds the live publisher can read without writing a snapshot.
The read variables are `CLEAN_SOURCE_S3_ENDPOINT`,
`CLEAN_SOURCE_S3_ACCESS_KEY_ID`, `CLEAN_SOURCE_S3_SECRET_ACCESS_KEY` and
optionally `CLEAN_SOURCE_S3_REGION` and `CLEAN_SOURCE_S3_SESSION_TOKEN`.

## Analytics

The production site counts visits and a few named interactions with cookieless
Plausible (the event list is in `apps/web/src/lib/site/analytics.ts`), and loads
the Cloudflare Web Analytics beacon when `PUBLIC_CF_BEACON_TOKEN` is also set.
Local runs and forks send nothing unless `PUBLIC_PLAUSIBLE_DOMAIN` is set and
the page is served from that host.

## License

The source is under the [MIT License](LICENSE). Agency data, map data, fonts and
GSAP keep their own terms, listed in [NOTICE](NOTICE). Transit is not affiliated
with STM, OC Transpo or any other transit agency.
