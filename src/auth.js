const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Authflow } = require('prismarine-auth');
const { createXboxApi } = require('./xboxApi');
const { StateStore } = require('./stateStore');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      cookies[name] = part.slice(index + 1).trim();
    }
  }
  return cookies;
}

function getCookie(req, name) {
  return parseCookies(req?.headers?.cookie)[name] || null;
}

function cookieOptions(config) {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.cookieSecure,
    path: '/'
  };
}

function setSessionCookie(res, config, accountId) {
  res.cookie(config.cookieName, accountId, {
    ...cookieOptions(config),
    maxAge: config.cookieMaxAgeMs
  });
}

function clearSessionCookie(res, config) {
  res.clearCookie(config.cookieName, cookieOptions(config));
}

function removeDir(dir) {
  if (!dir) return;
  fs.rm(dir, { recursive: true, force: true }, () => {});
}

class AuthManager {
  constructor(config, { logger = console, authflowFactory } = {}) {
    this.config = config;
    this.logger = logger;
    this.logins = new Map();
    this.accounts = new Map();
    this.authflowFactory = authflowFactory || ((username, cacheDir, options, onCode) =>
      new Authflow(username, cacheDir, options, onCode));
    this.stateStore = new StateStore(this.config.statePath, { logger: this.logger });
    fs.mkdirSync(this.config.cacheRoot, { recursive: true });
    this.restoreAccounts();
  }

  async startLogin() {
    const loginId = crypto.randomUUID();
    const cacheDir = path.join(this.config.cacheRoot, `account-${loginId}`);
    const login = {
      id: loginId,
      status: 'pending',
      code: null,
      error: null,
      createdAt: Date.now(),
      cacheDir,
      authflow: null,
      profile: null
    };
    this.logins.set(loginId, login);

    try {
      login.authflow = this.authflowFactory(
        loginId,
        cacheDir,
        {
          flow: this.config.authFlow,
          authTitle: this.config.bedrockTitleId,
          deviceType: this.config.authDeviceType
        },
        (code) => {
          login.code = {
            verificationUri: code?.verification_uri || code?.verificationUri || null,
            userCode: code?.user_code || code?.userCode || null,
            expiresIn: code?.expires_in ?? code?.expiresIn ?? null
          };
        }
      );
    } catch (error) {
      this.logins.delete(loginId);
      removeDir(cacheDir);
      const wrapped = new Error(`建立登入流程失敗：${error.message}`);
      wrapped.code = 'LOGIN_START_FAILED';
      throw wrapped;
    }

    login.tokenPromise = login.authflow.getXboxToken('http://xboxlive.com')
      .then(async (token) => {
        if (!this.logins.has(loginId)) return;

        try {
          const api = createXboxApi({ authflow: login.authflow, config: this.config });
          login.profile = await api.getProfile('me');
        } catch (error) {
          this.logger.warn(`[auth] 無法取得個人資料：${error.message}`);
          const fallback = token?.userXUID != null ? String(token.userXUID) : loginId;
          login.profile = { xuid: fallback, gamertag: fallback };
        }

        if (!this.logins.has(loginId)) return;
        login.status = 'success';
        this.logger.log(`[auth] 登入成功 xuid=${login.profile.xuid}`);
      })
      .catch((error) => {
        if (!this.logins.has(loginId)) return;
        login.status = 'error';
        login.error = error?.message || String(error);
        this.logger.warn(`[auth] 登入失敗：${login.error}`);
      });

    const deadline = Date.now() + this.config.deviceCodeWaitMs;
    while (!login.code && login.status === 'pending' && Date.now() < deadline) {
      await sleep(100);
    }

    if (!login.code) {
      const message = login.error || '無法取得裝置碼';
      await this.removeLogin(loginId);
      const error = new Error(message);
      error.code = 'DEVICE_CODE_UNAVAILABLE';
      throw error;
    }

    return {
      loginId,
      verificationUri: login.code.verificationUri,
      userCode: login.code.userCode,
      expiresIn: login.code.expiresIn
    };
  }

  async getLoginStatus(loginId) {
    const login = this.logins.get(loginId);
    if (!login) return { status: 'notfound' };

    if (Date.now() - login.createdAt > this.config.loginTtlMs) {
      await this.removeLogin(loginId);
      return { status: 'expired' };
    }

    if (login.status === 'pending') return { status: 'pending' };

    if (login.status === 'error') {
      const error = login.error || '登入失敗';
      await this.removeLogin(loginId);
      return { status: 'error', error };
    }

    const account = this.createAccount(login);
    this.logins.delete(loginId);
    return { status: 'success', account, profile: account.profile };
  }

  createAccount(login) {
    const xuid = login.profile?.xuid;
    if (xuid) {
      const existing = [...this.accounts.values()].find(
        (account) => account.profile?.xuid === xuid
      );
      if (existing) {
        existing.lastSeenAt = Date.now();
        if (login.profile?.gamertag) existing.profile = login.profile;
        removeDir(login.cacheDir);
        return existing;
      }
    }

    const account = {
      id: crypto.randomUUID(),
      username: login.id,
      authflow: login.authflow,
      cacheDir: login.cacheDir,
      profile: login.profile,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      sessions: [],
      discoveredAt: null,
      discovering: null,
      lastRefreshAt: 0
    };
    this.accounts.set(account.id, account);
    this.saveState();
    return account;
  }

  restoreAccounts() {
    const entries = this.stateStore.getAccounts() || [];
    let restored = 0;

    for (const entry of entries) {
      if (!entry?.id || !entry?.username || !entry?.cacheDir) continue;
      if (!fs.existsSync(entry.cacheDir)) continue;
      if ([...this.accounts.values()].some((account) => account.id === entry.id)) continue;

      try {
        const authflow = this.authflowFactory(
          entry.username,
          entry.cacheDir,
          {
            flow: this.config.authFlow,
            authTitle: this.config.bedrockTitleId,
            deviceType: this.config.authDeviceType
          },
          () => {
            throw new Error('登入快取已失效，請重新登入');
          }
        );

        const account = {
          id: entry.id,
          username: entry.username,
          authflow,
          cacheDir: entry.cacheDir,
          profile: entry.profile || null,
          createdAt: entry.createdAt || Date.now(),
          lastSeenAt: Date.now(),
          sessions: Array.isArray(entry.sessions) ? entry.sessions : [],
          discoveredAt: entry.discoveredAt || null,
          discovering: null,
          lastError: entry.lastError || null,
          lastRefreshAt: entry.lastRefreshAt || 0,
          restored: true
        };

        const duplicate = [...this.accounts.values()].find(
          (existing) => existing.profile?.xuid && existing.profile.xuid === account.profile?.xuid
        );
        if (duplicate) continue;

        this.accounts.set(account.id, account);
        restored += 1;
      } catch (error) {
        this.logger.warn(`[auth] 無法還原帳號 ${entry.profile?.gamertag || entry.id}：${error.message}`);
      }
    }

    if (restored > 0) {
      this.logger.log(`[auth] 已還原 ${restored} 個帳號`);
    }
  }

  saveState() {
    this.stateStore.setAccounts([...this.accounts.values()]);
  }

  async flushState() {
    await this.stateStore.flush();
  }

  getAccount(accountId) {
    if (!accountId) return null;
    const account = this.accounts.get(accountId);
    if (!account) return null;

    if (Date.now() - account.lastSeenAt > this.config.accountIdleTtlMs) {
      this.destroyAccount(accountId);
      return null;
    }

    account.lastSeenAt = Date.now();
    return account;
  }

  destroyAccount(accountId) {
    const account = this.accounts.get(accountId);
    if (!account) return;
    this.accounts.delete(accountId);
    removeDir(account.cacheDir);
    this.saveState();
    this.logger.log(`[auth] 移除帳號 ${account.profile?.gamertag || accountId}`);
  }

  listAccounts() {
    const now = Date.now();
    const live = [];
    for (const [accountId, account] of this.accounts) {
      if (now - account.lastSeenAt > this.config.accountIdleTtlMs) {
        this.destroyAccount(accountId);
        continue;
      }
      live.push(account);
    }
    return live;
  }

  async removeLogin(loginId) {
    const login = this.logins.get(loginId);
    if (!login) return;
    this.logins.delete(loginId);
    removeDir(login.cacheDir);
  }

  async prune() {
    const now = Date.now();
    const tasks = [];

    for (const [loginId, login] of this.logins) {
      if (now - login.createdAt > this.config.loginTtlMs) {
        this.logger.log(`[auth] 登入流程過期 ${loginId}`);
        tasks.push(this.removeLogin(loginId));
      }
    }

    for (const [accountId, account] of this.accounts) {
      if (now - account.lastSeenAt > this.config.accountIdleTtlMs) {
        tasks.push(Promise.resolve(this.destroyAccount(accountId)));
      }
    }

    await Promise.all(tasks);
  }

  async shutdown() {
    const tasks = [];
    for (const loginId of [...this.logins.keys()]) tasks.push(this.removeLogin(loginId));
    await Promise.all(tasks);

    this.saveState();
    await this.stateStore.flush();
  }
}

module.exports = {
  AuthManager,
  parseCookies,
  getCookie,
  setSessionCookie,
  clearSessionCookie
};
