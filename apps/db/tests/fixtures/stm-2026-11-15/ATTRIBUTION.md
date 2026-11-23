# STM service day fixture

Contains data from the Société de transport de Montréal (STM), made available
under [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/).
[STM open data](https://www.stm.info/a-propos/documents-donnees/donnees-ouvertes)

This extract covers all trips on STM lines 70 and 183 for service day
2026-11-15. The schedule ZIP retains the matching GTFS route, trip, stop time,
stop and calendar rows. The original schedule was captured on 2026-11-04 and
has SHA-256 `ce03a0a0b1fe5fbb9fb4d74ed574185b2400b00e469de4bb59e58820dab4609b`.

Each compressed JSON line stores the feed family, UTC capture timestamp and
base64 GTFS-Realtime protobuf. The extract keeps selected trip or route
entities with their original feed headers and capture timestamps, including
the overnight vehicle evidence. Polls containing only unrelated entities are
omitted. This fixture exercises trip and stop evidence. It does not establish
full-network poll coverage.

`expected.json` records the published v8 comparison for those lines. The
disagreements cover six Saturday trips entered as Sunday additions (47 stop
rows), six Sunday trips whose observations are labelled Monday (31 stop rows),
and one forecast discarded because it would reverse the order of two observed
stop times. Trip `302218773`, stop sequence 4, is the forecast example.
