const { mapLimit } = require('./discovery');
const { getSessionDocument } = require('./sessionCache');

function firstString(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}

function toCount(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function extractRoomMembers(document) {
  const raw = document?.members;
  const info = document?.membersInfo && typeof document.membersInfo === 'object'
    ? document.membersInfo
    : {};
  const members = [];
  const seen = new Set();

  if (raw && typeof raw === 'object') {
    for (const value of Object.values(raw)) {
      if (!value || typeof value !== 'object') continue;
      if (value.reserved === true || value.properties?.system?.reserved === true) continue;

      const xuid = firstString(value.constants?.system?.xuid);
      if (!xuid || seen.has(xuid)) continue;
      seen.add(xuid);

      const gamertag = firstString(value.gamertag, xuid);
      members.push({
        xuid,
        gamertag,
        active: value.properties?.system?.active === true,
        joinTime: firstString(value.joinTime)
      });
    }
  }

  members.sort((left, right) => {
    if (left.active !== right.active) return left.active ? -1 : 1;
    return left.gamertag.localeCompare(right.gamertag);
  });

  const accepted = toCount(info.accepted) ?? members.length;
  const membersInfo = {
    count: toCount(info.count) ?? members.length,
    accepted,
    active: toCount(info.active) ?? members.filter((member) => member.active).length
  };

  return {
    members,
    membersInfo,
    membersIncomplete: accepted > members.length
  };
}

function memberErrorMessage(error) {
  if (error?.status === 403) return '無權限讀取玩家名單';
  if (error?.status === 404) return '房間已不存在';
  return '玩家名單讀取失敗';
}

function preservedMembers(previous, error) {
  return {
    members: previous?.members || [],
    membersInfo: previous?.membersInfo || null,
    membersUpdatedAt: previous?.membersUpdatedAt || null,
    membersIncomplete: previous?.membersIncomplete || false,
    membersError: error ? memberErrorMessage(error) : null
  };
}

const MAX_COUNT_DIFFERENCE = 2;

function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
}

function evaluateRoomTrust(session, members) {
  const list = Array.isArray(members) ? members : [];
  const issues = [];

  const hostName = String(session?.hostName || '').trim();
  if (hostName && hostName !== 'Unknown host') {
    const hostTag = normalizeName(hostName);
    const hostInList = list.some((member) => normalizeName(member?.gamertag) === hostTag);
    if (!hostInList) issues.push('host-missing');
  }

  const reported = toCount(session?.memberCount);
  if (reported !== null) {
    if (Math.abs(reported - list.length) > MAX_COUNT_DIFFERENCE) {
      issues.push('count-mismatch');
    }
  }

  return issues;
}

async function attachRoomMembers(api, sessions, {
  config,
  logger = console,
  previousSessions = [],
  sessionDocuments
} = {}) {
  const previousBySession = new Map();
  for (const session of previousSessions || []) {
    if (session?.sessionName) previousBySession.set(session.sessionName, session);
  }

  const concurrency = config?.memberConcurrency ?? 8;

  return mapLimit(sessions, concurrency, async (session) => {
    const previous = previousBySession.get(session.sessionName);

    if (session.closed === true) {
      const preserved = preservedMembers(previous, null);
      const trustIssues = evaluateRoomTrust(session, preserved.members);
      return {
        ...session,
        ...preserved,
        trusted: trustIssues.length === 0,
        trustIssues
      };
    }

    if (session.memberCount === 0 && !(previous?.members?.length > 0)) {
      const trustIssues = evaluateRoomTrust(session, []);
      return {
        ...session,
        members: [],
        membersInfo: { count: 0, accepted: 0, active: 0 },
        membersUpdatedAt: Date.now(),
        membersIncomplete: false,
        membersError: null,
        trusted: trustIssues.length === 0,
        trustIssues
      };
    }

    try {
      const document = await getSessionDocument(api, session.sessionName, sessionDocuments);
      const parsed = extractRoomMembers(document);
      const trustIssues = evaluateRoomTrust(session, parsed.members);
      return {
        ...session,
        ...parsed,
        membersIncomplete: parsed.membersIncomplete ||
          (parsed.members.length === 0 && (session.memberCount || 0) > 0),
        membersUpdatedAt: Date.now(),
        membersError: null,
        trusted: trustIssues.length === 0,
        trustIssues
      };
    } catch (error) {
      logger.warn(`[members] ${session.sessionName} 讀取失敗：${error.message}`);
      const preserved = preservedMembers(previous, error);
      const trustIssues = evaluateRoomTrust(session, preserved.members);
      return {
        ...session,
        ...preserved,
        trusted: trustIssues.length === 0,
        trustIssues
      };
    }
  });
}

module.exports = {
  attachRoomMembers,
  evaluateRoomTrust,
  extractRoomMembers,
  memberErrorMessage
};
