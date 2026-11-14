const { parseJsonBig } = require('./xboxApi');
const { getSessionDocument } = require('./sessionCache');

function firstString(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}

function toNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseCustomProperties(value) {
  if (value === undefined || value === null) return {};
  if (typeof value === 'string') {
    try {
      const parsed = parseJsonBig(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' ? value : {};
}

function extractConnections(props) {
  const list = Array.isArray(props?.SupportedConnections) ? props.SupportedConnections : [];
  const netherNet = [];
  const legacy = [];

  for (const item of list) {
    if (!item || typeof item !== 'object') continue;

    const netherNetId = item.NetherNetId != null && String(item.NetherNetId).trim()
      ? String(item.NetherNetId).trim()
      : null;
    const webRtcNetworkId = item.WebRTCNetworkId != null && String(item.WebRTCNetworkId).trim()
      ? String(item.WebRTCNetworkId).trim()
      : null;
    const id = netherNetId || webRtcNetworkId;
    if (!id) continue;

    const connection = {
      netherNetId: id,
      pmsgId: firstString(item.PmsgId, item.PMsgId),
      connectionType: toNumber(item.ConnectionType),
      transport: netherNetId ? 'nethernet' : 'webrtc'
    };

    if (netherNetId) netherNet.push(connection);
    else legacy.push(connection);
  }

  const chosen = netherNet.length > 0 ? netherNet : legacy;
  const seen = new Set();
  return chosen.filter((connection) => {
    const key = `${connection.netherNetId}|${connection.pmsgId || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isMinecraftHandle(handle, config) {
  if (!handle?.sessionRef?.name) return false;
  const scid = handle.sessionRef.scid;
  if (config?.scid && scid && String(scid).toLowerCase() !== String(config.scid).toLowerCase()) {
    return false;
  }
  const templateName = handle.sessionRef.templateName;
  if (config?.templateName && templateName && templateName !== config.templateName) {
    return false;
  }
  return true;
}

function normalizeSession(handle, {
  scid,
  templateName,
  customProperties,
  gamertagByXuid
} = {}) {
  if (!handle || typeof handle !== 'object') return null;

  const ref = handle.sessionRef;
  if (!ref || !ref.name) return null;
  if (scid && ref.scid && String(ref.scid).toLowerCase() !== String(scid).toLowerCase()) return null;
  if (templateName && ref.templateName && ref.templateName !== templateName) return null;

  const props = parseCustomProperties(
    customProperties !== undefined ? customProperties : handle.customProperties
  );
  const connections = extractConnections(props);
  if (connections.length === 0) return null;

  const related = handle.relatedInfo && typeof handle.relatedInfo === 'object'
    ? handle.relatedInfo
    : {};

  const ownerXuid = firstString(handle.ownerXuid, props.ownerId);
  const gamertag = ownerXuid && gamertagByXuid ? gamertagByXuid.get(ownerXuid) : null;

  return {
    sessionName: String(ref.name),
    handleId: firstString(handle.id),
    ownerXuid,
    hostName: firstString(props.hostName, gamertag) || 'Unknown host',
    worldName: firstString(props.worldName) || 'Unknown world',
    version: firstString(props.version),
    memberCount: toNumber(props.MemberCount) ?? toNumber(related.membersCount),
    maxMemberCount: toNumber(props.MaxMemberCount) ?? toNumber(related.maxMembersCount),
    joinability: firstString(props.Joinability, related.joinRestriction),
    visibility: firstString(related.visibility),
    joinRestriction: firstString(related.joinRestriction),
    closed: related.closed === true,
    connections,
    templateName: firstString(ref.templateName) || templateName || null
  };
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function queryHandlesByXuid(api, xuids, chunkSize, warnings, concurrency = 1) {
  const unique = [...new Set(xuids.filter(Boolean).map(String))];
  const chunks = [];
  for (let index = 0; index < unique.length; index += chunkSize) {
    chunks.push(unique.slice(index, index + chunkSize));
  }

  const results = await mapLimit(chunks, Math.max(1, concurrency), async (chunk) => {
    try {
      return { handles: await api.queryActivityHandles({ xuids: chunk }), warning: null };
    } catch (error) {
      return {
        handles: [],
        warning: `批次活動查詢失敗（${chunk.length} 人）：${error.message}`
      };
    }
  });

  const handles = [];
  for (const result of results) {
    handles.push(...result.handles);
    if (result.warning) warnings.push(result.warning);
  }
  return handles;
}

function dedupeCandidates(candidates) {
  const bySession = new Map();
  for (const candidate of candidates) {
    const handle = candidate.handle;
    const key = handle?.sessionRef?.name || handle?.id;
    if (!key || bySession.has(key)) continue;
    bySession.set(key, candidate);
  }
  return [...bySession.values()];
}

async function discoverFriendWorlds(api, selfXuid, {
  config,
  logger = console,
  sessionDocuments
} = {}) {
  if (!selfXuid) throw new TypeError('discoverFriendWorlds 需要 selfXuid');

  const startedAt = Date.now();
  const xuid = String(selfXuid);
  const friendWarnings = [];
  const selfWarnings = [];
  const gamertagByXuid = new Map();
  const chunkSize = config?.handlesChunkSize ?? 50;
  const concurrency = config?.discoveryConcurrency ?? 8;
  const fallbackConcurrency = config?.fallbackConcurrency ?? 2;
  const documentCache = sessionDocuments instanceof Map ? sessionDocuments : null;

  let friendHandles = [];
  let friendSource = 'people';
  let friendDiscoveryFailed = false;

  const friendPromise = (async () => {
    try {
      friendHandles = await api.queryActivityHandles({
        people: { moniker: 'people', monikerXuid: xuid }
      });
    } catch (error) {
      friendWarnings.push(`好友活動查詢失敗：${error.message}`);
      try {
        const friends = await api.listFriends();
        for (const friend of friends) {
          if (friend.gamertag) gamertagByXuid.set(friend.xuid, friend.gamertag);
        }
        friendHandles = await queryHandlesByXuid(
          api,
          [xuid, ...friends.map((friend) => friend.xuid)],
          chunkSize,
          friendWarnings,
          fallbackConcurrency
        );
        friendSource = 'xuids-fallback';
      } catch (fallbackError) {
        friendWarnings.push(`好友清單查詢失敗：${fallbackError.message}`);
        friendDiscoveryFailed = true;
      }
    }
  })();

  const selfPromise = (async () => {
    try {
      return await api.queryActivityHandles({ xuids: [xuid] });
    } catch (error) {
      selfWarnings.push(`自己的活動查詢失敗：${error.message}`);
      return [];
    }
  })();

  const [, selfHandles] = await Promise.all([friendPromise, selfPromise]);
  const warnings = [...friendWarnings, ...selfWarnings];

  if (friendDiscoveryFailed) {
    for (const warning of warnings) logger.warn(`[discovery] ${warning}`);
    throw new Error(`無法取得好友活動：${friendWarnings[friendWarnings.length - 1] || '未知錯誤'}`);
  }

  const relatedHandles = [
    ...friendHandles.map((handle) => ({ handle, source: 'friends' })),
    ...selfHandles.map((handle) => ({ handle, source: 'self' }))
  ].filter(({ handle }) => isMinecraftHandle(handle, config));

  const candidates = dedupeCandidates(relatedHandles);
  let missingDocs = 0;

  const sessions = await mapLimit(candidates, concurrency, async ({ handle, source }) => {
    let session = normalizeSession(handle, {
      scid: config?.scid,
      templateName: config?.templateName,
      gamertagByXuid
    });

    if (!session) {
      const name = handle?.sessionRef?.name;
      if (!name) return null;
      try {
        const document = await getSessionDocument(api, name, documentCache);
        session = normalizeSession(handle, {
          scid: config?.scid,
          templateName: config?.templateName,
          customProperties: document?.properties?.custom,
          gamertagByXuid
        });
        if (!session) missingDocs++;
      } catch {
        missingDocs++;
        return null;
      }
    }

    return session ? { ...session, discoveredBy: source } : null;
  });

  const seenSessions = new Set();
  const finalSessions = [];
  for (const session of sessions) {
    if (!session) continue;
    const key = session.sessionName || session.handleId;
    if (!key || seenSessions.has(key)) continue;
    seenSessions.add(key);
    finalSessions.push(session);
  }

  finalSessions.sort((left, right) => {
    const host = left.hostName.localeCompare(right.hostName);
    return host !== 0 ? host : left.worldName.localeCompare(right.worldName);
  });

  const resultLimit = config?.handlesResultLimit ?? 100;
  if (friendHandles.length + selfHandles.length >= resultLimit) {
    warnings.push(`活動筆數達到 ${resultLimit} 筆上限，部分好友房間可能未顯示`);
  }

  const stats = {
    friendHandles: friendHandles.length,
    selfHandles: selfHandles.length,
    candidates: candidates.length,
    parsed: finalSessions.length,
    missingDocs,
    friendSource,
    durationMs: Date.now() - startedAt
  };

  logger.log(
    `[discovery] friends=${stats.friendHandles} self=${stats.selfHandles} ` +
    `candidates=${stats.candidates} parsed=${stats.parsed} missingDocs=${stats.missingDocs} ` +
    `source=${stats.friendSource} ms=${stats.durationMs}`
  );
  for (const warning of warnings) logger.warn(`[discovery] ${warning}`);

  return { sessions: finalSessions, warnings, stats };
}

module.exports = {
  discoverFriendWorlds,
  normalizeSession,
  parseCustomProperties,
  extractConnections,
  isMinecraftHandle,
  mapLimit
};
