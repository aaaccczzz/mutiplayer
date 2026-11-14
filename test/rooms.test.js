const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../src/config');
const {
  isFresh,
  refreshAccount,
  getRoomsPayload,
  getMergedRoomsPayload,
  getAccountsSummary
} = require('../src/rooms');
const sessionDocument = require('../fixtures/session-response.json');

const silentLogger = { log() {}, warn() {} };
const testConfig = {
  ...config,
  discoveryConcurrency: 2,
  memberConcurrency: 2,
  handlesResultLimit: 100,
  handlesChunkSize: 50
};

function makeHandle(hostName) {
  return {
    id: 'h1',
    ownerXuid: '2535400000000002',
    sessionRef: {
      scid: testConfig.scid,
      templateName: testConfig.templateName,
      name: 'sess-1'
    },
    relatedInfo: { membersCount: 1, maxMembersCount: 8 },
    customProperties: JSON.stringify({
      hostName,
      worldName: 'World',
      version: '1.21.0',
      MemberCount: 1,
      MaxMemberCount: 8,
      Joinability: 'Anyone',
      SupportedConnections: [{ ConnectionType: 7, NetherNetId: '12345678901234567890' }]
    })
  };
}

function makeAccount(overrides = {}) {
  return {
    id: 'account-1',
    profile: { xuid: '2535400000000001', gamertag: 'Me' },
    authflow: {},
    sessions: [],
    discoveredAt: null,
    discovering: null,
    lastError: null,
    lastRefreshAt: 0,
    ...overrides
  };
}

function makeApi({ hostName = 'Alex', getSession } = {}) {
  return {
    async queryActivityHandles() {
      return [makeHandle(hostName)];
    },
    async listFriends() {
      return [];
    },
    async getSession(name) {
      if (getSession) return getSession(name);
      return sessionDocument;
    }
  };
}

test('isFresh 依 roomTtlMs 判斷快取', () => {
  assert.equal(isFresh(makeAccount({ discoveredAt: Date.now() }), testConfig), true);
  assert.equal(
    isFresh(makeAccount({ discoveredAt: Date.now() - testConfig.roomTtlMs - 1000 }), testConfig),
    false
  );
  assert.equal(isFresh(makeAccount(), testConfig), false);
});

test('refreshAccount 更新快照與時間', async () => {
  const account = makeAccount();
  await refreshAccount(account, makeApi(), testConfig, silentLogger);

  assert.equal(account.sessions.length, 1);
  assert.equal(account.sessions[0].hostName, 'Alex');
  assert.equal(account.sessions[0].connections[0].netherNetId, '12345678901234567890');
  assert.equal(account.sessions[0].members.length, 3);
  assert.equal(account.sessions[0].membersInfo.active, 2);
  assert.equal(account.sessions[0].membersError, null);
  assert.ok(account.sessions[0].membersUpdatedAt > 0);
  assert.equal(account.sessions[0].trusted, true);
  assert.ok(account.discoveredAt > 0);
  assert.equal(account.lastError, null);
  assert.equal(account.discovering, null);
});

test('玩家名單讀取失敗不影響房間快取', async () => {
  const account = makeAccount();
  const error = new Error('forbidden');
  error.status = 403;

  await refreshAccount(account, makeApi({
    getSession: async () => { throw error; }
  }), testConfig, silentLogger);

  assert.equal(account.sessions.length, 1);
  assert.deepEqual(account.sessions[0].members, []);
  assert.equal(account.sessions[0].membersError, '無權限讀取玩家名單');
  assert.ok(account.discoveredAt > 0);
});

test('同時呼叫 refreshAccount 只會觸發一次 discovery', async () => {
  const account = makeAccount();
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });

  const api = {
    async queryActivityHandles() {
      calls += 1;
      await gate;
      return [makeHandle('Alex')];
    },
    async listFriends() {
      return [];
    },
    async getSession() {
      return sessionDocument;
    }
  };

  const first = refreshAccount(account, api, testConfig, silentLogger);
  const second = refreshAccount(account, api, testConfig, silentLogger);

  release();
  await Promise.all([first, second]);

  assert.equal(calls, 2);
  assert.equal(account.sessions.length, 1);
  assert.equal(account.discovering, null);
});

test('refreshAccount 失敗時保留舊快照並標記錯誤', async () => {
  const previous = [{ sessionName: 'old' }];
  const account = makeAccount({ sessions: previous, discoveredAt: 1 });
  const failingApi = {
    async queryActivityHandles() {
      throw new Error('boom');
    },
    async listFriends() {
      throw new Error('also boom');
    },
    async getSession() {
      throw new Error('unused');
    }
  };

  await assert.rejects(
    refreshAccount(account, failingApi, testConfig, silentLogger),
    /無法取得好友活動/
  );

  assert.equal(account.sessions, previous);
  assert.equal(account.discoveredAt, 1);
  assert.match(account.lastError, /無法取得好友活動/);
  assert.equal(account.discovering, null);
});

test('getRoomsPayload 依 gamertag 排序並標示過期狀態', () => {
  const zed = makeAccount({
    id: 'z',
    profile: { xuid: '2', gamertag: 'Zed' },
    discoveredAt: Date.now(),
    sessions: [{ sessionName: 's', hostName: 'Zed' }]
  });
  const amy = makeAccount({
    id: 'a',
    profile: { xuid: '3', gamertag: 'Amy' },
    discoveredAt: null,
    sessions: [],
    lastError: 'boom'
  });

  const payload = getRoomsPayload([zed, amy], testConfig);

  assert.deepEqual(payload.map((room) => room.account.gamertag), ['Amy', 'Zed']);
  assert.equal(payload[0].stale, true);
  assert.equal(payload[0].error, 'boom');
  assert.equal(payload[0].updatedAt, null);
  assert.equal(payload[1].stale, false);
  assert.equal(payload[1].error, null);
  assert.equal(payload[1].sessions[0].sessionName, 's');
  assert.ok(payload[1].updatedAt);
});

test('getRoomsPayload 標示背景更新中的帳號', () => {
  const account = makeAccount({
    discovering: Promise.resolve(),
    sessions: []
  });

  const [payload] = getRoomsPayload([account], testConfig);

  assert.equal(payload.refreshing, true);
});

function makeSession(overrides = {}) {
  return {
    sessionName: 'sess-1',
    worldName: 'World',
    hostName: 'Alex',
    members: [],
    membersUpdatedAt: 0,
    discoveredBy: 'friends',
    ...overrides
  };
}

test('getMergedRoomsPayload 依 sessionName 合併多個帳號看到的同一個房間', () => {
  const amy = makeAccount({
    id: 'a',
    profile: { xuid: '2', gamertag: 'Amy' },
    sessions: [makeSession({ discoveredBy: 'friends' })]
  });
  const bob = makeAccount({
    id: 'b',
    profile: { xuid: '3', gamertag: 'Bob' },
    sessions: [makeSession({ discoveredBy: 'self' })]
  });

  const rooms = getMergedRoomsPayload([amy, bob], testConfig);

  assert.equal(rooms.length, 1);
  assert.equal(rooms[0].sessionName, 'sess-1');
  assert.deepEqual(rooms[0].broadcasters, [
    { id: 'a', gamertag: 'Amy', xuid: '2', discoveredBy: 'friends' },
    { id: 'b', gamertag: 'Bob', xuid: '3', discoveredBy: 'self' }
  ]);
});

test('getMergedRoomsPayload 保留玩家名單較豐富的快照', () => {
  const amy = makeAccount({
    id: 'a',
    profile: { xuid: '2', gamertag: 'Amy' },
    sessions: [makeSession({ members: [], membersUpdatedAt: 100 })]
  });
  const bob = makeAccount({
    id: 'b',
    profile: { xuid: '3', gamertag: 'Bob' },
    sessions: [makeSession({
      members: [{ xuid: '9', gamertag: 'Cara', active: true }],
      membersUpdatedAt: 50
    })]
  });

  const rooms = getMergedRoomsPayload([amy, bob], testConfig);

  assert.equal(rooms.length, 1);
  assert.equal(rooms[0].members.length, 1);
  assert.equal(rooms[0].members[0].gamertag, 'Cara');
  assert.equal(rooms[0].broadcasters.length, 2);
});

test('getMergedRoomsPayload 不會合併不同 session 的房間', () => {
  const amy = makeAccount({
    sessions: [makeSession({ sessionName: 's1', worldName: 'World B' })]
  });
  const bob = makeAccount({
    sessions: [makeSession({ sessionName: 's2', worldName: 'World A' })]
  });

  const rooms = getMergedRoomsPayload([amy, bob], testConfig);

  assert.equal(rooms.length, 2);
  assert.deepEqual(rooms.map((room) => room.worldName), ['World A', 'World B']);
});

test('getMergedRoomsPayload 保留不信任房間並帶有標記', () => {
  const amy = makeAccount({
    sessions: [
      makeSession({
        sessionName: 'good',
        worldName: 'World Good',
        hostName: 'Alex',
        members: [{ xuid: '1', gamertag: 'Alex', active: true }],
        memberCount: 1,
        trusted: true,
        trustIssues: []
      }),
      makeSession({
        sessionName: 'bad',
        worldName: 'World Bad',
        hostName: 'NotHere',
        members: [{ xuid: '2', gamertag: 'Bob', active: true }],
        memberCount: 9,
        trusted: false,
        trustIssues: ['host-missing', 'count-mismatch']
      })
    ]
  });

  const rooms = getMergedRoomsPayload([amy], testConfig);
  const byName = Object.fromEntries(rooms.map((room) => [room.sessionName, room]));

  assert.equal(rooms.length, 2);
  assert.equal(byName.good.trusted, true);
  assert.equal(byName.bad.trusted, false);
  assert.deepEqual(byName.bad.trustIssues, ['host-missing', 'count-mismatch']);
});

test('getAccountsSummary 只計算信任的房間數', () => {
  const amy = makeAccount({
    sessions: [
      makeSession({ trusted: true }),
      makeSession({ sessionName: 'bad', trusted: false })
    ]
  });

  const summary = getAccountsSummary([amy], testConfig);

  assert.equal(summary[0].sessionCount, 1);
});

test('getAccountsSummary 回傳每個廣播帳號的狀態', () => {
  const amy = makeAccount({
    id: 'a',
    profile: { xuid: '2', gamertag: 'Amy' },
    discoveredAt: Date.now(),
    sessions: [makeSession()]
  });
  const bob = makeAccount({
    id: 'b',
    profile: { xuid: '3', gamertag: 'Bob' },
    lastError: 'boom'
  });

  const summary = getAccountsSummary([bob, amy], testConfig);

  assert.deepEqual(summary.map((item) => item.gamertag), ['Amy', 'Bob']);
  assert.equal(summary[0].stale, false);
  assert.equal(summary[0].sessionCount, 1);
  assert.equal(summary[1].stale, true);
  assert.equal(summary[1].error, 'boom');
  assert.equal(summary[1].sessionCount, 0);
});
