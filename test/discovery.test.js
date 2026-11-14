const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const config = require('../src/config');
const { parseJsonBig } = require('../src/xboxApi');
const {
  discoverFriendWorlds,
  normalizeSession,
  parseCustomProperties,
  extractConnections,
  isMinecraftHandle
} = require('../src/discovery');

const silentLogger = { log() {}, warn() {} };
const testConfig = {
  ...config,
  discoveryConcurrency: 2,
  handlesResultLimit: 100,
  handlesChunkSize: 50
};

const fixture = parseJsonBig(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'handles-response.json'), 'utf8')
);

const sessionDocument = {
  properties: {
    custom: {
      hostName: 'Herobrine',
      worldName: 'Empty World',
      version: '1.21.0',
      MemberCount: 1,
      MaxMemberCount: 20,
      Joinability: 'Anyone',
      SupportedConnections: [
        { ConnectionType: 7, NetherNetId: '9999999999999999999', PmsgId: 'fallback1' }
      ]
    }
  }
};

function bySessionName(sessions, name) {
  return sessions.find((session) => session.sessionName === name);
}

test('normalizeSession 解析字串形式的 customProperties 與 64-bit NetherNetId', () => {
  const session = normalizeSession(fixture.results[0], {
    scid: testConfig.scid,
    templateName: testConfig.templateName
  });

  assert.ok(session);
  assert.equal(session.sessionName, 'sess-survival');
  assert.equal(session.hostName, 'Alex');
  assert.equal(session.worldName, 'Survival Realm');
  assert.equal(session.version, '1.21.60');
  assert.equal(session.memberCount, 3);
  assert.equal(session.maxMemberCount, 8);
  assert.equal(session.joinability, 'FriendsOnly');
  assert.equal(session.visibility, 'friends');
  assert.equal(session.connections.length, 1);
  assert.equal(session.connections[0].netherNetId, '15778080650974306186');
  assert.equal(session.connections[0].pmsgId, 'a1b2c3');
  assert.equal(session.connections[0].transport, 'nethernet');
});

test('WebRTCNetworkId 可作為 NetherNetId 缺席時的備援', () => {
  const session = normalizeSession(fixture.results[1], {
    scid: testConfig.scid,
    templateName: testConfig.templateName
  });

  assert.ok(session);
  assert.equal(session.connections.length, 1);
  assert.equal(session.connections[0].netherNetId, 'webrtc-9f8e7d');
  assert.equal(session.connections[0].transport, 'webrtc');
});

test('parseCustomProperties 對無效或缺少連線的內容回傳空結果', () => {
  assert.deepEqual(parseCustomProperties('{not json'), {});
  assert.deepEqual(parseCustomProperties(null), {});
  assert.deepEqual(extractConnections(parseCustomProperties('{"hostName":"x"}')), []);
  assert.deepEqual(extractConnections({}), []);
});

test('isMinecraftHandle 過濾非 MinecraftLobby 或非目標 SCID 的活動', () => {
  assert.equal(isMinecraftHandle(fixture.results[0], testConfig), true);
  assert.equal(isMinecraftHandle(fixture.results[2], testConfig), false);
  assert.equal(isMinecraftHandle({
    sessionRef: { name: 'x', scid: 'other', templateName: testConfig.templateName }
  }, testConfig), false);
  assert.equal(isMinecraftHandle({}, testConfig), false);
});

test('discoverFriendWorlds 合併好友與自己、去重並以 session doc 補資料', async () => {
  const calls = { people: 0, xuids: 0, sessions: [] };
  const api = {
    async queryActivityHandles(owners) {
      if (owners.people) {
        calls.people += 1;
        return fixture.results;
      }
      calls.xuids += 1;
      return [fixture.results[0]];
    },
    async getSession(name) {
      calls.sessions.push(name);
      return sessionDocument;
    },
    async listFriends() {
      throw new Error('不應呼叫 listFriends');
    }
  };

  const result = await discoverFriendWorlds(api, '2535400000000001', {
    config: testConfig,
    logger: silentLogger
  });

  assert.equal(result.sessions.length, 3);
  assert.deepEqual(calls.sessions, ['sess-empty']);
  assert.equal(calls.people, 1);
  assert.equal(calls.xuids, 1);
  assert.equal(result.stats.candidates, 3);
  assert.equal(result.stats.friendSource, 'people');
  assert.deepEqual(result.warnings, []);

  const empty = bySessionName(result.sessions, 'sess-empty');
  assert.ok(empty);
  assert.equal(empty.hostName, 'Herobrine');
  assert.equal(empty.connections[0].netherNetId, '9999999999999999999');

  assert.deepEqual(
    result.sessions.map((session) => session.hostName),
    ['Alex', 'Herobrine', 'Steve']
  );
});

test('discoverFriendWorlds 使用既有的 session document 快取', async () => {
  const documents = new Map([['sess-empty', sessionDocument]]);
  let sessionCalls = 0;
  const api = {
    async queryActivityHandles(owners) {
      return owners.people ? [fixture.results[3]] : [];
    },
    async listFriends() {
      throw new Error('不應呼叫 listFriends');
    },
    async getSession() {
      sessionCalls += 1;
      throw new Error('不應呼叫 getSession');
    }
  };

  const result = await discoverFriendWorlds(api, '2535400000000001', {
    config: testConfig,
    logger: silentLogger,
    sessionDocuments: documents
  });

  assert.equal(sessionCalls, 0);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].hostName, 'Herobrine');
});

test('people 查詢失敗時改用好友清單批次查詢', async () => {
  const calls = { people: 0, xuids: 0 };
  const api = {
    async queryActivityHandles(owners) {
      if (owners.people) {
        calls.people += 1;
        throw new Error('people down');
      }
      calls.xuids += 1;
      return [fixture.results[0]];
    },
    async listFriends() {
      return [{ xuid: '2535400000000002', gamertag: 'Alex' }];
    },
    async getSession() {
      throw new Error('no doc');
    }
  };

  const result = await discoverFriendWorlds(api, '2535400000000001', {
    config: testConfig,
    logger: silentLogger
  });

  assert.equal(result.stats.friendSource, 'xuids-fallback');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /people down/);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].hostName, 'Alex');
  assert.equal(calls.xuids, 2);
});

test('好友來源全部失敗時拋錯', async () => {
  const api = {
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
    discoverFriendWorlds(api, '1', { config: testConfig, logger: silentLogger }),
    /無法取得好友活動/
  );
});

test('session doc 取得失敗時略過該房間並記錄 missingDocs', async () => {
  const api = {
    async queryActivityHandles(owners) {
      return owners.people ? [fixture.results[3]] : [];
    },
    async listFriends() {
      return [];
    },
    async getSession() {
      throw new Error('missing');
    }
  };

  const result = await discoverFriendWorlds(api, '1', {
    config: testConfig,
    logger: silentLogger
  });

  assert.equal(result.sessions.length, 0);
  assert.equal(result.stats.missingDocs, 1);
});
