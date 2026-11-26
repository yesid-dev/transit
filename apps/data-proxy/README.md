# Basemap API

`GET /v2/cities` includes a `basemap_v2_url` field on each provider. It is
the absolute public PMTiles URL on `https://data.yesid.dev`, or `null`
when the provider has no matching basemap declaration. The existing
`basemap_url` field retains its published value.

`GET` and `HEAD /v2/{city}/basemap/{file}.pmtiles` support byte ranges and
conditional requests. The response exposes `X-Transit-Source` to browser
clients. It is `clean` when served by clean storage and `legacy` when
served by the snapshot fallback. A proxy-generated 404 has no source header.
