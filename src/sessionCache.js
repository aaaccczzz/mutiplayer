const inFlightByCache = new WeakMap();
const statsByCache = new WeakMap();

function getInFlightMap(cache) {
  if (!(cache instanceof Map)) return null;
  let inFlight = inFlightByCache.get(cache);
  if (!inFlight) {
    inFlight = new Map();
    inFlightByCache.set(cache, inFlight);
  }
  return inFlight;
}

function getStats(cache) {
  let stats = statsByCache.get(cache);
  if (!stats) {
    stats = { hits: 0, inFlightHits: 0, misses: 0 };
    statsByCache.set(cache, stats);
  }
  return stats;
}

async function getSessionDocument(api, name, cache) {
  if (!name) throw new TypeError('getSessionDocument 需要 session 名稱');
  if (cache?.has(name)) {
    getStats(cache).hits += 1;
    return cache.get(name);
  }

  const inFlight = getInFlightMap(cache);
  if (inFlight?.has(name)) {
    getStats(cache).inFlightHits += 1;
    return inFlight.get(name);
  }

  if (cache) getStats(cache).misses += 1;

  const promise = api.getSession(name).then(
    (document) => {
      if (cache) cache.set(name, document);
      if (inFlight) inFlight.delete(name);
      return document;
    },
    (error) => {
      if (inFlight) inFlight.delete(name);
      throw error;
    }
  );

  if (inFlight) inFlight.set(name, promise);
  return promise;
}

function getSessionCacheStats(cache) {
  if (!(cache instanceof Map)) return { hits: 0, inFlightHits: 0, misses: 0 };
  return { ...getStats(cache) };
}

module.exports = { getSessionDocument, getSessionCacheStats };
