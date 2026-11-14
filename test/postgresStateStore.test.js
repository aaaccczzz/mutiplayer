const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PostgresStateStore } = require('../src/postgresStateStore');

const silentLogger = { log() {}, warn() {} };

function createFakePool() {
  const queries = [];
  const stored = { value: null };
  const pool = {
    queries,
    ended: false,
    async query(text, params) {
      queries.push({ text, params });
      if (/CREATE TABLE/.test(text)) return { rows: [] };
      if (/SELECT data FROM/.test(text)) {
        return { rows: stored.value ? [{ data: stored.value }] : [] };
      }
      if (/INSERT INTO/.test(text)) {
        stored.value = JSON.parse(params[1]);
        return { rows: [] };
      }
      return { rows: [] };
    },
    async end() {
      pool.ended = true;
    }
  };
  return pool;
}

function createStore(pool, options = {}) {
  return new PostgresStateStore('postgresql://user:pass@localhost:5432/test', {
    logger: silentLogger,
    poolFactory: () => pool,
    ...options
  });
}

function makeAccount(overrides = {}) {
  return {
    id: 'account-1',
    username: 'login-1',
    cacheDir: '/tmp/cache',
    profile: { xuid: '2535400000000001', gamertag: 'Me' },
    createdAt: 1,
    lastSeenAt: 2,
    discoveredAt: 3,
    lastRefreshAt: 4,
    lastError: null,
    authflow: { internal: '不應被序列化' },
    discovering: Promise.resolve(),
    ...overrides
  };
}

test('有變動就立即寫入 PostgreSQL', async () => {
  const pool = createFakePool();
  const store = createStore(pool);

  store.setAccounts([makeAccount()]);
  await store.flush();

  const inserts = pool.queries.filter((query) => /INSERT INTO/.test(query.text));
  assert.equal(inserts.length, 1);
  const data = JSON.parse(inserts[0].params[1]);
  assert.equal(data.accounts.length, 1);
  assert.equal(data.accounts[0].id, 'account-1');
  assert.equal(data.accounts[0].authflow, undefined);
  assert.equal(data.accounts[0].discovering, undefined);
  assert.ok(data.savedAt);
});

test('連續多次變動合併為最新一次寫入', async () => {
  const pool = createFakePool();
  const store = createStore(pool);

  store.setAccounts([makeAccount({ id: 'a' })]);
  store.setAccounts([makeAccount({ id: 'b' })]);
  store.setAccounts([makeAccount({ id: 'c' })]);
  await store.flush();

  const inserts = pool.queries.filter((query) => /INSERT INTO/.test(query.text));
  assert.equal(inserts.length, 1);
  const data = JSON.parse(inserts[0].params[1]);
  assert.deepEqual(data.accounts.map((account) => account.id), ['c']);
});

test('getAccounts 讀回已寫入的資料', async () => {
  const pool = createFakePool();
  const store = createStore(pool);

  store.setAccounts([makeAccount()]);
  await store.flush();

  const accounts = await store.getAccounts();
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].profile.gamertag, 'Me');
});

test('沒有資料時回傳空陣列', async () => {
  const pool = createFakePool();
  const store = createStore(pool);

  assert.deepEqual(await store.getAccounts(), []);
});

test('首次讀取時從舊狀態檔遷移', async () => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xbox-pg-state-test-'));
  const legacyPath = path.join(cacheRoot, 'state.json');
  const legacyAccount = {
    id: 'legacy-1',
    username: 'legacy-login',
    cacheDir: path.join(cacheRoot, 'cache'),
    profile: { xuid: '1', gamertag: 'Legacy' },
    sessions: [{ sessionName: 'sess-1' }]
  };
  fs.writeFileSync(legacyPath, JSON.stringify({ version: 1, accounts: [legacyAccount] }));

  try {
    const pool = createFakePool();
    const store = createStore(pool, { legacyStatePath: legacyPath });

    const accounts = await store.getAccounts();
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].profile.gamertag, 'Legacy');

    const inserts = pool.queries.filter((query) => /INSERT INTO/.test(query.text));
    assert.equal(inserts.length, 1);

    assert.deepEqual(await store.getAccounts(), accounts);
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('寫入失敗時記錄警告且不中斷後續寫入', async () => {
  const warnings = [];
  const pool = createFakePool();
  const baseQuery = pool.query.bind(pool);
  let failing = true;
  pool.query = async (text, params) => {
    if (/INSERT INTO/.test(text) && failing) throw new Error('connection refused');
    return baseQuery(text, params);
  };
  const store = new PostgresStateStore('postgresql://user:pass@localhost:5432/test', {
    logger: { log() {}, warn: (message) => warnings.push(message) },
    poolFactory: () => pool
  });

  store.setAccounts([makeAccount()]);
  await store.flush();
  assert.equal(warnings.length, 1);

  failing = false;
  store.setAccounts([makeAccount({ id: 'retry' })]);
  await store.flush();

  const accounts = await store.getAccounts();
  assert.equal(accounts[0].id, 'retry');
});

test('close 會 flush 並關閉連線池', async () => {
  const pool = createFakePool();
  const store = createStore(pool);

  store.setAccounts([makeAccount()]);
  await store.close();

  assert.equal(pool.ended, true);
  const inserts = pool.queries.filter((query) => /INSERT INTO/.test(query.text));
  assert.equal(inserts.length, 1);
});
