const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { StateStore, STATE_VERSION } = require('../src/stateStore');

const silentLogger = { log() {}, warn() {} };

function makeAccount(overrides = {}) {
  return {
    id: 'account-1',
    username: 'login-1',
    cacheDir: '/tmp/cache/account-1',
    profile: { xuid: '2535400000000001', gamertag: 'Alex' },
    createdAt: 1,
    lastSeenAt: 2,
    discoveredAt: 3,
    lastRefreshAt: 4,
    lastError: null,
    sessions: [{ sessionName: 'sess-1' }],
    ...overrides
  };
}

test('StateStore 儲存並載入帳號狀態', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbox-state-test-'));
  const filePath = path.join(dir, 'state.json');

  try {
    const store = new StateStore(filePath, { logger: silentLogger });
    store.setAccounts([makeAccount()]);
    await store.flush();

    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(raw.version, STATE_VERSION);
    assert.equal(raw.accounts.length, 1);
    assert.equal(raw.accounts[0].id, 'account-1');
    assert.equal(raw.accounts[0].username, 'login-1');
    assert.equal(raw.accounts[0].sessions[0].sessionName, 'sess-1');

    const reloaded = new StateStore(filePath, { logger: silentLogger });
    assert.equal(reloaded.getAccounts().length, 1);
    assert.equal(reloaded.getAccounts()[0].profile.gamertag, 'Alex');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('StateStore 忽略損毀的狀態檔並備份', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbox-state-test-'));
  const filePath = path.join(dir, 'state.json');
  fs.writeFileSync(filePath, '{ not json');

  try {
    const store = new StateStore(filePath, { logger: silentLogger });
    assert.deepEqual(store.getAccounts(), []);

    const backups = fs.readdirSync(dir).filter((name) => name.startsWith('state.json.corrupt-'));
    assert.equal(backups.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
