const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const config = require('../src/config');
const { AuthManager } = require('../src/auth');

const silentLogger = { log() {}, warn() {} };

function createMemoryStateStore() {
  return {
    accounts: [],
    async getAccounts() {
      return this.accounts;
    },
    setAccounts(accounts) {
      this.accounts = accounts;
    },
    async flush() {},
    async close() {}
  };
}

test('AuthManager 使用 live flow 與 Nintendo 裝置類型開始登入', async () => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xbox-auth-test-'));
  const testConfig = { ...config, cacheRoot, deviceCodeWaitMs: 1000 };
  let captured = null;

  const auth = new AuthManager(testConfig, {
    logger: silentLogger,
    stateStore: createMemoryStateStore(),
    authflowFactory(username, cacheDir, options, onCode) {
      captured = { username, cacheDir, options };
      onCode({
        verification_uri: 'https://example.test/device',
        user_code: 'ABCD-1234',
        expires_in: 900
      });
      return { getXboxToken: () => new Promise(() => {}) };
    }
  });

  try {
    const login = await auth.startLogin();

    assert.equal(login.verificationUri, 'https://example.test/device');
    assert.equal(login.userCode, 'ABCD-1234');
    assert.equal(login.expiresIn, 900);
    assert.ok(login.loginId);

    assert.ok(captured);
    assert.equal(captured.options.flow, 'live');
    assert.equal(captured.options.authTitle, testConfig.bedrockTitleId);
    assert.equal(captured.options.deviceType, testConfig.authDeviceType);
    assert.equal(captured.options.deviceType, 'Nintendo');
    assert.equal(path.dirname(captured.cacheDir), cacheRoot);

    const status = await auth.getLoginStatus(login.loginId);
    assert.equal(status.status, 'pending');
  } finally {
    await auth.shutdown();
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('AuthManager 從狀態儲存庫還原帳號', async () => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xbox-auth-restore-test-'));
  const cacheDir = path.join(cacheRoot, 'account-restored');
  fs.mkdirSync(cacheDir, { recursive: true });
  const savedAccount = {
    id: 'restored-account',
    username: 'restored-login',
    cacheDir,
    profile: { xuid: '2535400000000001', gamertag: 'Restored' },
    createdAt: 1,
    lastSeenAt: 2,
    discoveredAt: 3,
    lastRefreshAt: 4,
    lastError: null,
    sessions: [{ sessionName: 'sess-1' }]
  };
  const stateStore = createMemoryStateStore();
  stateStore.accounts = [savedAccount];

  let created = null;
  const auth = new AuthManager(
    { ...config, cacheRoot },
    {
      logger: silentLogger,
      stateStore,
      authflowFactory(username, dir) {
        created = { username, dir };
        return {
          getXboxToken: async () => ({
            userXUID: savedAccount.profile.xuid,
            userHash: 'user-hash',
            XSTSToken: 'xsts-token'
          })
        };
      }
    }
  );

  try {
    await auth.init();

    assert.equal(auth.listAccounts().length, 1);
    const restored = auth.getAccount(savedAccount.id);
    assert.equal(restored.username, savedAccount.username);
    assert.equal(restored.profile.gamertag, savedAccount.profile.gamertag);
    assert.equal(restored.sessions[0].sessionName, savedAccount.sessions[0].sessionName);
    assert.ok(created);
    assert.equal(created.username, savedAccount.username);
    assert.equal(created.dir, cacheDir);

    await auth.shutdown();
    assert.ok(fs.existsSync(cacheDir));
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
});
