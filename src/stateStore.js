const fs = require('fs');
const path = require('path');

const STATE_VERSION = 1;

function serializeAccount(account) {
  if (!account) return null;
  return {
    id: account.id || null,
    username: account.username || account.id || null,
    cacheDir: account.cacheDir || null,
    profile: account.profile || null,
    createdAt: account.createdAt || null,
    lastSeenAt: account.lastSeenAt || null,
    discoveredAt: account.discoveredAt || null,
    lastRefreshAt: account.lastRefreshAt || 0,
    lastError: account.lastError || null,
    sessions: Array.isArray(account.sessions) ? account.sessions : []
  };
}

class StateStore {
  constructor(filePath, { logger = console } = {}) {
    this.filePath = path.resolve(filePath);
    this.logger = logger;
    this.state = { version: STATE_VERSION, accounts: [] };
    this.saveTimer = null;
    this.savePromise = null;
    this.load();
  }

  load() {
    let text;
    try {
      text = fs.readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.logger.warn(`[state] 無法讀取狀態檔：${error.message}`);
      }
      return;
    }

    try {
      const parsed = JSON.parse(text);
      if (parsed?.version === STATE_VERSION && Array.isArray(parsed.accounts)) {
        this.state = { version: STATE_VERSION, accounts: parsed.accounts };
      }
    } catch (error) {
      const backupPath = `${this.filePath}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(this.filePath, backupPath);
        this.logger.warn(`[state] 狀態檔損毀，已備份至 ${backupPath}`);
      } catch (renameError) {
        this.logger.warn(`[state] 狀態檔損毀且無法備份：${renameError.message}`);
      }
    }
  }

  getAccounts() {
    return this.state.accounts;
  }

  setAccounts(accounts) {
    this.state = {
      version: STATE_VERSION,
      accounts: (accounts || [])
        .map(serializeAccount)
        .filter(Boolean)
    };
    this.scheduleSave();
  }

  scheduleSave(delayMs = 1000) {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save().catch((error) => {
        this.logger.warn(`[state] 無法儲存狀態：${error.message}`);
      });
    }, delayMs);
    this.saveTimer.unref?.();
  }

  cancelScheduledSave() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  async writeState() {
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await fs.promises.writeFile(tempPath, JSON.stringify(this.state, null, 2));
    await fs.promises.rename(tempPath, this.filePath);
  }

  async save() {
    if (this.savePromise) return this.savePromise;
    this.savePromise = this.writeState().finally(() => {
      this.savePromise = null;
    });
    return this.savePromise;
  }

  async flush() {
    this.cancelScheduledSave();
    if (this.savePromise) return this.savePromise;
    return this.save();
  }
}

module.exports = { StateStore, STATE_VERSION };
