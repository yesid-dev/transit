import { CleanObjectChanged } from "./clean-download-store.js";

const MAX_INDEX_BYTES = 8 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

function tripAtStop(stopId, report) {
  const [
    trip_id, route_id, direction_id, start_date, start_time, relationship, delay,
    sequence, arrival, departure, arrival_delay, departure_delay, stopRelationship,
  ] = report;
  return {
    trip_id, route_id, direction_id, start_date, start_time, relationship, delay,
    stops: [{
      stop_id: stopId, sequence, arrival, departure, arrival_delay, departure_delay,
      relationship: stopRelationship,
    }],
  };
}

export async function readLiveTrips(store, city, scope) {
  const base = `live/v2/${city}/trips`;
  const object = await store.get(`${base}.json`);
  if (!object) return null;
  if (object.size > MAX_INDEX_BYTES) {
    await object.body?.cancel();
    throw new Error("Oversized live trip index");
  }
  const index = await object.json();
  if (index?.version !== 2 || index.city !== city || index.feed?.family !== "trip_updates") {
    throw new Error("Unexpected live trip index");
  }
  const key = `${scope.kind}:${scope.id}`;
  const header = { version: 2, city, feed: index.feed };
  if (!Object.hasOwn(index.ranges, key)) return { ...header, trip_updates: [] };
  const [offset, length] = index.ranges[key];
  if (
    !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) ||
    offset < 0 || length <= 0 || offset + length > MAX_BUNDLE_BYTES ||
    typeof index.etag !== "string" || !/^"[^"\r\n]+"$/.test(index.etag)
  ) throw new Error("Invalid live trip range");
  const part = await store.get(`${base}.bin`, {
    range: { offset, length },
    ifMatch: index.etag,
  });
  if (!part || part.etag !== index.etag) {
    await part?.body?.cancel();
    throw new CleanObjectChanged("Live trip publication changed");
  }
  const payload = await part.json();
  const tripUpdates = scope.kind === "stop"
    ? payload.map((report) => tripAtStop(scope.id, report))
    : Array.isArray(payload) ? payload : [payload];
  return { ...header, trip_updates: tripUpdates };
}
