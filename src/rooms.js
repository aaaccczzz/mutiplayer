const { discoverFriendWorlds, mapLimit } = require('./discovery');
const { attachRoomMembers } = require('./members');
const { getSessionCacheStats } = require('./sessionCache');
const { createXboxApi } = require('./xboxApi');

function isFresh(account, config) {
  if (!account?.discoveredAt) return false;
  return Date.now() - account.discoveredAt < config.roomTtlMs;
}

function apiForAccount(account, config) {
  return createXboxApi({ authflow: account.authflow, config });
}

async function refreshAccount(account, api, config, logger = console, { sessionDocuments } = {}) {
  if (account.discovering) return account.discovering;

  account.discovering = (async () => {
    const startedAt = Date.now();
    try {
      const documents = sessionDocuments instanceof Map ? sessionDocuments : new Map();
      const result = await discoverFriendWorlds(api, account.profile.xuid, {
        config,
        logger,
        sessionDocuments: documents
      });
      const membersStartedAt = Date.now();
      const sessions = await attachRoomMembers(api, result.sessions, {
        config,
        logger,
        previousSessions: account.sessions,
        sessionDocuments: documents
      });
      const membersMs = Date.now() - membersStartedAt;

      account.sessions = sessions;
      account.discoveredAt = Date.now();
      account.lastError = null;

      const apiStats = api.stats || {};
      const cacheStats = getSessionCacheStats(documents);
      const stats = {
        ...result.stats,
        members: sessions.reduce((sum, session) => sum + (session.members?.length || 0), 0),
        memberErrors: sessions.filter((session) => session.membersError).length,
        membersMs,
        totalMs: Date.now() - startedAt,
        requests: apiStats.requests || 0,
        retries: apiStats.retries || 0,
        status429: apiStats.status429 || 0,
        cacheHits: cacheStats.hits + cacheStats.inFlightHits
      };

      logger.log(
        `[rooms] ${account.profile?.gamertag || account.id} rooms=${sessions.length} ` +
        `members=${stats.members} discoveryMs=${stats.durationMs ?? 0} membersMs=${stats.membersMs} ` +
        `totalMs=${stats.totalMs} requests=${stats.requests} retries=${stats.retries} ` +
        `status429=${stats.status429} cacheHits=${stats.cacheHits}`
      );

      return { ...result, sessions, stats };
    } catch (error) {
      account.lastError = error.message;
      logger.warn(`[rooms] ${account.profile?.gamertag || account.id} 更新失敗：${error.message}`);
      throw error;
    } finally {
      account.discovering = null;
    }
  })();

  return account.discovering;
}

async function refreshAccounts(accounts, { config, logger = console, concurrency } = {}) {
  const limit = concurrency ?? config.refreshAccountsConcurrency ?? 2;
  const sessionDocuments = new Map();

  const results = await mapLimit(accounts, limit, async (account) => {
    try {
      await refreshAccount(
        account,
        apiForAccount(account, config),
        config,
        logger,
        { sessionDocuments }
      );
      return { account, ok: true };
    } catch (error) {
      return { account, ok: false, error: error.message };
    }
  });
  return results;
}

function accountView(account, config) {
  return {
    account: {
      id: account.id || null,
      gamertag: account.profile?.gamertag || null,
      xuid: account.profile?.xuid || null
    },
    updatedAt: account.discoveredAt ? new Date(account.discoveredAt).toISOString() : null,
    stale: !isFresh(account, config),
    refreshing: Boolean(account.discovering),
    error: account.lastError || null,
    sessions: account.sessions || []
  };
}

function getRoomsPayload(accounts, config) {
  return accounts
    .map((account) => accountView(account, config))
    .sort((left, right) => String(left.account.gamertag).localeCompare(String(right.account.gamertag)));
}

function getAccountsSummary(accounts, config) {
  return accounts
    .map((account) => ({
      id: account.id || null,
      gamertag: account.profile?.gamertag || null,
      xuid: account.profile?.xuid || null,
      updatedAt: account.discoveredAt ? new Date(account.discoveredAt).toISOString() : null,
      stale: !isFresh(account, config),
      refreshing: Boolean(account.discovering),
      error: account.lastError || null,
      sessionCount: (account.sessions || []).filter((session) => session.trusted !== false).length
    }))
    .sort((left, right) => String(left.gamertag).localeCompare(String(right.gamertag)));
}

function isRicherSession(candidate, current) {
  const candidateMembers = candidate.members?.length || 0;
  const currentMembers = current.members?.length || 0;
  if (candidateMembers !== currentMembers) return candidateMembers > currentMembers;
  return (candidate.membersUpdatedAt || 0) > (current.membersUpdatedAt || 0);
}

function getMergedRoomsPayload(accounts, config) {
  const views = accounts.map((account) => accountView(account, config));
  const bySession = new Map();

  for (const view of views) {
    for (const session of view.sessions || []) {
      const key = session.sessionName || session.handleId;
      if (!key) continue;

      const broadcaster = {
        id: view.account.id,
        gamertag: view.account.gamertag,
        xuid: view.account.xuid,
        discoveredBy: session.discoveredBy || null
      };

      const existing = bySession.get(key);
      if (!existing) {
        bySession.set(key, { ...session, broadcasters: [broadcaster] });
        continue;
      }

      existing.broadcasters.push(broadcaster);
      if (isRicherSession(session, existing)) {
        Object.assign(existing, session, { broadcasters: existing.broadcasters });
      }
    }
  }

  return [...bySession.values()].sort((left, right) => {
    const world = String(left.worldName).localeCompare(String(right.worldName));
    return world !== 0 ? world : String(left.hostName).localeCompare(String(right.hostName));
  });
}

module.exports = {
  isFresh,
  apiForAccount,
  refreshAccount,
  refreshAccounts,
  getRoomsPayload,
  getAccountsSummary,
  getMergedRoomsPayload
};
