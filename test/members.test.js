const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../src/config');
const { extractRoomMembers, attachRoomMembers, evaluateRoomTrust } = require('../src/members');
const sessionDocument = require('../fixtures/session-response.json');

const silentLogger = { log() {}, warn() {} };
const testConfig = {
  ...config,
  memberConcurrency: 2
};

test('extractRoomMembers 解析成員、排除邀請中成員並依在線狀態排序', () => {
  const result = extractRoomMembers(sessionDocument);

  assert.deepEqual(result.members.map((member) => member.gamertag), ['Alex', 'BlueBoot', 'Steve']);
  assert.equal(result.members[0].active, true);
  assert.equal(result.members[2].active, false);
  assert.equal(result.members.some((member) => member.gamertag === 'Invited'), false);
  assert.deepEqual(result.membersInfo, { count: 4, accepted: 3, active: 2 });
  assert.equal(result.membersIncomplete, false);
});

test('extractRoomMembers 缺少 gamertag 時使用 XUID', () => {
  const result = extractRoomMembers({
    members: {
      0: {
        constants: { system: { xuid: '2535400000000099' } },
        properties: { system: { active: true } },
        gamertag: ''
      }
    }
  });

  assert.equal(result.members.length, 1);
  assert.equal(result.members[0].gamertag, '2535400000000099');
});

test('attachRoomMembers 為房間附加玩家名單並快取 session document', async () => {
  const calls = [];
  const documents = new Map();
  const api = {
    async getSession(name) {
      calls.push(name);
      return sessionDocument;
    }
  };

  const result = await attachRoomMembers(api, [{ sessionName: 'sess-1' }], {
    config: testConfig,
    logger: silentLogger,
    sessionDocuments: documents
  });

  assert.equal(calls.length, 1);
  assert.equal(result[0].members.length, 3);
  assert.equal(result[0].membersInfo.active, 2);
  assert.equal(result[0].membersError, null);
  assert.ok(result[0].membersUpdatedAt > 0);
  assert.equal(documents.get('sess-1'), sessionDocument);
});

test('attachRoomMembers 讀取失敗時保留上一次的玩家名單', async () => {
  const previous = {
    sessionName: 'sess-1',
    members: [{ xuid: '1', gamertag: 'Old', active: true }],
    membersInfo: { count: 1, accepted: 1, active: 1 },
    membersUpdatedAt: 123,
    membersIncomplete: false
  };
  const error = new Error('forbidden');
  error.status = 403;

  const result = await attachRoomMembers({
    async getSession() {
      throw error;
    }
  }, [{ sessionName: 'sess-1' }], {
    config: testConfig,
    logger: silentLogger,
    previousSessions: [previous]
  });

  assert.deepEqual(result[0].members, previous.members);
  assert.equal(result[0].membersUpdatedAt, 123);
  assert.equal(result[0].membersError, '無權限讀取玩家名單');
});

test('attachRoomMembers 跳過已關閉房間的玩家查詢', async () => {
  const result = await attachRoomMembers({
    async getSession() {
      throw new Error('不應呼叫');
    }
  }, [{ sessionName: 'sess-closed', closed: true }], {
    config: testConfig,
    logger: silentLogger
  });

  assert.deepEqual(result[0].members, []);
  assert.equal(result[0].membersError, null);
});

test('evaluateRoomTrust 主機不在玩家名單時不信任', () => {
  const session = { hostName: 'Alex', memberCount: 2 };
  const members = [
    { gamertag: 'Steve', active: true },
    { gamertag: 'Bob', active: true }
  ];

  assert.deepEqual(evaluateRoomTrust(session, members), ['host-missing']);
});

test('evaluateRoomTrust 人數誤差 2 以內允許、超過不信任', () => {
  const members = [
    { gamertag: 'Alex', active: true },
    { gamertag: 'Steve', active: true },
    { gamertag: 'Bob', active: true }
  ];

  assert.deepEqual(evaluateRoomTrust({ hostName: 'Alex', memberCount: 5 }, members), []);
  assert.deepEqual(evaluateRoomTrust({ hostName: 'Alex', memberCount: 1 }, members), []);
  assert.deepEqual(evaluateRoomTrust({ hostName: 'Alex', memberCount: 6 }, members), ['count-mismatch']);
  assert.deepEqual(evaluateRoomTrust({ hostName: 'Alex', memberCount: 0 }, members), ['count-mismatch']);
});

test('evaluateRoomTrust 未知主機或缺少人數時略過對應檢查', () => {
  assert.deepEqual(evaluateRoomTrust({ hostName: 'Unknown host' }, []), []);
  assert.deepEqual(evaluateRoomTrust({}, []), []);
  assert.deepEqual(
    evaluateRoomTrust({ hostName: 'alex', memberCount: null }, [{ gamertag: 'ALEX', active: true }]),
    []
  );
});

test('attachRoomMembers 為信任的房間標記 trusted', async () => {
  const result = await attachRoomMembers({
    async getSession() {
      return sessionDocument;
    }
  }, [{ sessionName: 'sess-1', hostName: 'Alex', memberCount: 1 }], {
    config: testConfig,
    logger: silentLogger
  });

  assert.equal(result[0].trusted, true);
  assert.deepEqual(result[0].trustIssues, []);
});

test('attachRoomMembers 為不信任的房間標記 trusted=false 與原因', async () => {
  const result = await attachRoomMembers({
    async getSession() {
      return sessionDocument;
    }
  }, [{ sessionName: 'sess-1', hostName: 'NotHere', memberCount: 10 }], {
    config: testConfig,
    logger: silentLogger
  });

  assert.equal(result[0].trusted, false);
  assert.deepEqual(result[0].trustIssues, ['host-missing', 'count-mismatch']);
});
