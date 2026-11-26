# Basemap API

`GET /v2/cities` includes a `basemap_v2_url` field on each provider. It is
the absolute public PMTiles URL on `https://data.yesid.dev`, or `null`
when the provider has no matching basemap declaration. The existing
`basemap_url` field retains its published value.

`GET` and `HEAD /v2/{city}/basemap/{file}.pmtiles` support byte ranges and
conditional requests. The route serves PMTiles from clean storage and
exposes `X-Transit-Source: clean` to browser clients. A missing object
returns HTTP 404 with the proxy's standard empty body and no source header.
A clean-storage failure or timeout before the first bytes returns an empty
HTTP 503 with `Cache-Control: no-store` and `Retry-After: 30`.
