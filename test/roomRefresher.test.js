const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../src/config');
const { RoomRefresher } = require('../src/roomRefresher');

const silentLogger = { log() {}, warn() {} };
const testConfig = {
  ...config,
  refreshAccountsConcurrency: 2
};

test('RoomRefresher.run 更新所有廣播帳號', async () => {
  const accounts = [
    { id: 'a', broadcastEnabled: true, sessions: [{ sessionName: 's1', members: [{ xuid: '1' }] }] },
    { id: 'b', broadcastEnabled: true, sessions: [] }
  ];
  let received = null;

  const refresher = new RoomRefresher({
    auth: { listAccounts: () => accounts },
    config: testConfig,
    logger: silentLogger,
    refreshAll: async (targets, options) => {
      received = { targets, options };
      return targets.map((account) => ({ account, ok: true }));
    }
  });

  const result = await refresher.run();

  assert.deepEqual(received.targets.map((account) => account.id), ['a', 'b']);
  assert.equal(received.options.config, testConfig);
  assert.equal(received.options.concurrency, 2);
  assert.equal(result.skipped, false);
  assert.equal(result.results.length, 2);
  assert.ok(refresher.lastRunAt > 0);
});

test('RoomRefresher.run 略過未開啟廣播的帳號', async () => {
  let received = null;

  const refresher = new RoomRefresher({
    auth: {
      listAccounts: () => [
        { id: 'off', sessions: [{ sessionName: 's1' }] },
        { id: 'on', broadcastEnabled: true, sessions: [] }
      ]
    },
    config: testConfig,
    logger: silentLogger,
    refreshAll: async (targets) => {
      received = targets;
      return targets.map((account) => ({ account, ok: true }));
    }
  });

  const result = await refresher.run();

  assert.equal(result.skipped, false);
  assert.deepEqual(received.map((account) => account.id), ['on']);
});

test('RoomRefresher.run 全部未廣播時跳過 API', async () => {
  let called = false;
  const refresher = new RoomRefresher({
    auth: { listAccounts: () => [{ id: 'off', sessions: [] }] },
    config: testConfig,
    logger: silentLogger,
    refreshAll: async () => {
      called = true;
      return [];
    }
  });

  const result = await refresher.run();

  assert.equal(result.skipped, true);
  assert.equal(called, false);
});

test('RoomRefresher.run 合併重疊的更新', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });

  const refresher = new RoomRefresher({
    auth: { listAccounts: () => [{ id: 'a', broadcastEnabled: true, sessions: [] }] },
    config: testConfig,
    logger: silentLogger,
    refreshAll: async (targets) => {
      calls += 1;
      await gate;
      return targets.map((account) => ({ account, ok: true }));
    }
  });

  const first = refresher.run();
  const second = refresher.run();
  release();
  await Promise.all([first, second]);

  assert.equal(calls, 1);
});

test('RoomRefresher.warmAccount 使用該帳號的 API 立即更新', async () => {
  const account = { id: 'a' };
  let captured = null;

  const refresher = new RoomRefresher({
    auth: { listAccounts: () => [] },
    config: testConfig,
    logger: silentLogger,
    apiFactory: (target, targetConfig) => ({ target, config: targetConfig }),
    refreshOne: async (target, api, targetConfig, logger) => {
      captured = { target, api, targetConfig, logger };
      return 'ok';
    }
  });

  const result = await refresher.warmAccount(account);

  assert.equal(result, 'ok');
  assert.equal(captured.target, account);
  assert.equal(captured.api.target, account);
  assert.equal(captured.api.config, testConfig);
  assert.equal(captured.targetConfig, testConfig);
  assert.equal(captured.logger, silentLogger);
});

test('RoomRefresher.warmAccount 更新失敗時不拋錯', async () => {
  const refresher = new RoomRefresher({
    auth: { listAccounts: () => [] },
    config: testConfig,
    logger: silentLogger,
    apiFactory: () => ({}),
    refreshOne: async () => {
      throw new Error('boom');
    }
  });

  assert.equal(await refresher.warmAccount({ id: 'a' }), null);
});
