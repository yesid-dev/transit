const COMMON_CUTS = [
  "line", "direction", "hour", "day_type", "effect", "cause", "format", "lang", "from_stop", "to_stop",
];

export const QUESTION_PARAMS = {
  measure: {
    required: ["from", "to", "measure"],
    optional: [...COMMON_CUTS, "stop", "departure", "vehicle", "group", "alert_details", "view"],
  },
  ranking: {
    required: ["from", "to", "measure", "kind"],
    optional: [...COMMON_CUTS, "class", "limit"],
  },
  "search-index": { required: [], optional: [] },
  "schedule-index": { required: [], optional: [] },
  "schedule-map": { required: [], optional: ["lines"] },
  live: { required: [], optional: [] },
  "live-trips": { required: [], optional: ["line", "stop", "trip"] },
  cities: { required: [], optional: [] },
  "data-health": { required: ["from", "to"], optional: [] },
  "how-we-measure": { required: [], optional: ["lang"] },
};

const oneOf = (...values) => (value) => values.includes(value);
const scheduleId = (value) => value === value.trim() && !/[^\S ]|\p{C}/u.test(value);
const VALID = {
  measure: (value) => /^[a-z][a-z0-9_]*$/.test(value),
  line: scheduleId,
  stop: scheduleId,
  trip: scheduleId,
  from_stop: scheduleId,
  to_stop: scheduleId,
  vehicle: scheduleId,
  effect: scheduleId,
  cause: scheduleId,
  direction: oneOf("0", "1"),
  departure: (value) => /^[0-9]{2,6}:[0-5][0-9]:[0-5][0-9]$/.test(value),
  alert_details: oneOf("1"),
  hour: (value) => /^(?:[01]?[0-9]|2[0-3])$/.test(value),
  day_type: oneOf("weekday", "saturday", "sunday"),
  group: oneOf("day", "hour", "day_type", "weekday_hour", "direction", "stop", "departure", "line", "stop_id", "segment", "vehicle", "effect", "cause"),
  kind: oneOf("line", "stop", "departure", "vehicle", "segment"),
  class: (value) => /^(?:all|(?:[0-9]+|unknown|mixed):(?:night|frequent|regular))$/.test(value),
  limit: (value) => /^[0-9]{1,3}$/.test(value) && Number(value) >= 1 && Number(value) <= 500,
  format: oneOf("json", "csv"),
  lang: oneOf("en", "fr"),
  view: oneOf("map"),
};

export function serviceDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return NaN;
  const date = new Date(value);
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value ? +date : NaN;
}

export function parseQuestion(url) {
  const catalog = ["/v2/how-we-measure", "/v2/cities"].includes(url.pathname);
  const match = /^\/v2\/([^/]+)\/(measure|ranking|data-health|search-index|schedule-index|schedule-map|live|live-trips)$/.exec(url.pathname);
  if (!catalog && !match) return null;

  const [, city, route] = match ?? [null, null, url.pathname.slice("/v2/".length)];
  if (["search-index", "schedule-index", "schedule-map", "live", "live-trips"].includes(route) && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(city)) {
    throw new Error("invalid city");
  }
  const { required, optional } = QUESTION_PARAMS[route];
  const query = url.search.slice(1);
  if (query.length > 4096) throw new Error("query string is too long");
  const params = new URLSearchParams();
  for (const field of query ? query.split("&") : []) {
    const separator = field.indexOf("=");
    if (separator < 1) throw new Error("use name=value for each parameter");
    const name = decodeURIComponent(field.slice(0, separator).replaceAll("+", " "));
    const value = decodeURIComponent(field.slice(separator + 1).replaceAll("+", " "));
    if (!required.includes(name) && !optional.includes(name)) throw new Error("unknown parameter");
    if (params.has(name) || !value || (VALID[name] && !VALID[name](value))) {
      throw new Error(`invalid or repeated ${name}`);
    }
    params.set(name, value);
  }
  for (const name of required) {
    if (!params.has(name)) throw new Error(`provide ${name}`);
  }
  if (params.has("lines")) {
    const ids = JSON.parse(params.get("lines"));
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 256 ||
        !ids.every((id) => typeof id === "string" && id.length > 0 && [...id].length <= 256 &&
          scheduleId(id) && !/\p{Z}/u.test(id.replaceAll(" ", "")))) {
      throw new Error("provide 1 to 256 valid line IDs");
    }
    params.set("lines", JSON.stringify([...new Set(ids)].sort()));
  }

  const end = params.get("to");
  if (required.includes("to")) {
    const days = (serviceDate(end) - serviceDate(params.get("from"))) / 86_400_000 + 1;
    if (!(days >= 1 && days <= 400)) {
      throw new Error("provide an ordered YYYY-MM-DD range of at most 400 days");
    }
    if (params.has("alert_details") && days > 7) {
      throw new Error("alert_details supports at most 7 service dates");
    }
  }
  if (params.has("departure") && (!params.has("line") || !params.has("direction"))) {
    throw new Error("departure requires line and direction");
  }
  if (params.has("alert_details") && (params.get("measure") !== "alert_counts" || params.has("group"))) {
    throw new Error("alert_details requires ungrouped alert_counts");
  }
  if (params.has("class") && params.get("kind") !== "line") {
    throw new Error("class applies to line rankings");
  }

  for (const name of ["hour", "limit"]) {
    if (params.has(name)) params.set(name, String(Number(params.get(name))));
  }
  const csv = params.get("format") === "csv";
  const map = params.get("view") === "map";
  if (map) {
    const scope = [...params.keys()].filter((key) =>
      !["from", "to", "measure", "group", "view", "format", "lang"].includes(key));
    const stops = params.get("measure") === "late" && params.get("group") === "stop_id" && !scope.length;
    const segments = params.get("measure") === "mean_time_lost" && params.get("group") === "segment" &&
      (!scope.length || (params.has("line") && scope.every((key) => key === "line" || key === "direction")));
    if (csv || !(stops || segments)) throw new Error("invalid map measure");
  } else if (params.get("group") === "segment") {
    throw new Error("group=segment requires map view");
  }
  // The engine's JSON and catalog already contain both languages.
  if (!csv || params.get("lang") === "en") params.delete("lang");
  if (!csv) params.delete("format");
  if (params.get("limit") === "100") params.delete("limit");
  params.sort();

  let scope;
  if (route === "live-trips") {
    if (params.size !== 1) throw new Error("provide one line, stop, or trip");
    const [kind, id] = params.entries().next().value;
    if (id.length > 256) throw new Error("invalid scope ID");
    scope = { kind, id };
  }
  const path = city === null ? `/${route}` : `/${city}/${route}`;
  const key = params.size ? `${path}?${params}` : path;
  const upstream = new URL(`https://transit-engine.internal/${route}`);
  if (city !== null) params.set("city", city);
  params.sort();
  upstream.search = params.toString();
  if (params.has("lines") && upstream.search.length > 4097) {
    throw new Error("query string is too long");
  }
  const networkCorridors = map && params.get("group") === "segment" && !params.has("line");
  return { city, route, end, csv, key, upstream, scope, map, networkCorridors };
}
