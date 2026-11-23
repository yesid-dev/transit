const MAX_INDEX_BYTES = 8 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const PARALLEL_RANGES = 8;

function own(record, key) {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function selects(scope, trip) {
  if (scope.kind === "line") return trip.route_id === scope.id ? trip : null;
  if (scope.kind === "trip") return trip.trip_id === scope.id ? trip : null;
  const stops = trip.stops.filter((stop) => stop.stop_id === scope.id);
  return stops.length ? { ...trip, stops } : null;
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
  const groups = scope.kind === "line"
    ? (own(index.ranges, `line:${scope.id}`) ? [`line:${scope.id}`] : [])
    : own(scope.kind === "trip" ? index.by_trip : index.by_stop, scope.id) ?? [];
  const tripUpdates = [];
  for (let i = 0; i < groups.length; i += PARALLEL_RANGES) {
    const parts = await Promise.all(groups.slice(i, i + PARALLEL_RANGES).map(async (group) => {
      const [offset, length] = own(index.ranges, group);
      if (
        !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) ||
        offset < 0 || length <= 0 || offset + length > MAX_BUNDLE_BYTES
      ) throw new Error("Invalid live trip range");
      const part = await store.get(`${base}.bin`, { range: { offset, length } });
      if (!part || !index.etag || part.etag !== index.etag) {
        await part?.body?.cancel();
        throw new Error("Live trip publication changed");
      }
      return part.json();
    }));
    for (const part of parts) {
      for (const trip of part) {
        const selected = selects(scope, trip);
        if (selected) tripUpdates.push(selected);
      }
    }
  }
  return { version: 2, city, feed: index.feed, trip_updates: tripUpdates };
}
