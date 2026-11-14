const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const STATE_KEY = 'accounts';
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

function sslForConnectionString(connectionString) {
  try {
    const { hostname } = new URL(connectionString);
    if (['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname)) return false;
    return { rejectUnauthorized: false };
  } catch {
    return false;
  }
}

class PostgresStateStore {
  constructor(connectionString, {
    logger = console,
    table = 'app_state',
    ssl,
    legacyStatePath = null,
    poolFactory
  } = {}) {
    if (!connectionString) throw new Error('需要 PostgreSQL 連線字串');
    this.logger = logger;
    this.table = table;
    this.legacyStatePath = legacyStatePath ? path.resolve(legacyStatePath) : null;
    this.pool = poolFactory
      ? poolFactory()
      : new Pool({
          connectionString,
          max: 3,
          connectionTimeoutMillis: 10000,
          ssl: ssl !== undefined ? ssl : sslForConnectionString(connectionString)
        });
    this.pool.on?.('error', (error) => {
      this.logger.warn(`[state] PostgreSQL 連線錯誤：${error.message}`);
    });
    this.writeChain = Promise.resolve();
    this.pendingData = null;
    this.migrated = false;
    this.ready = this.initialize();
  }

  async initialize() {
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS ${this.table} (
         id TEXT PRIMARY KEY,
         data JSONB NOT NULL,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`
    );
  }

  async getAccounts() {
    try {
      await this.ready;
      const result = await this.pool.query(
        `SELECT data FROM ${this.table} WHERE id = $1`,
        [STATE_KEY]
      );
      const data = result.rows?.[0]?.data;
      if (data && Array.isArray(data.accounts)) return data.accounts;
      return await this.migrateLegacyState();
    } catch (error) {
      this.logger.warn(`[state] 讀取失敗：${error.message}`);
      return [];
    }
  }

  async migrateLegacyState() {
    if (this.migrated || !this.legacyStatePath) return [];
    this.migrated = true;
    try {
      const text = fs.readFileSync(this.legacyStatePath, 'utf8');
      const parsed = JSON.parse(text);
      const accounts = Array.isArray(parsed?.accounts)
        ? parsed.accounts.map(serializeAccount).filter(Boolean)
        : [];
      if (accounts.length === 0) return [];
      this.logger.log(`[state] 從舊狀態檔匯入 ${accounts.length} 個帳號至 PostgreSQL`);
      await this.writeNow(accounts);
      return accounts;
    } catch (error) {
      this.logger.warn(`[state] 舊狀態檔匯入失敗：${error.message}`);
      return [];
    }
  }

  async writeNow(accounts) {
    const data = {
      version: STATE_VERSION,
      savedAt: new Date().toISOString(),
      accounts
    };
    await this.pool.query(
      `INSERT INTO ${this.table} (id, data)
       VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE
       SET data = EXCLUDED.data, updated_at = now()`,
      [STATE_KEY, JSON.stringify(data)]
    );
  }

  setAccounts(accounts) {
    this.pendingData = (accounts || []).map(serializeAccount).filter(Boolean);
    this.writeChain = this.writeChain
      .then(() => this.flushPending())
      .catch((error) => this.logger.warn(`[state] 寫入失敗：${error.message}`));
    return this.writeChain;
  }

  async flushPending() {
    if (this.pendingData === null) return;
    const data = this.pendingData;
    this.pendingData = null;
    await this.ready;
    await this.writeNow(data);
  }

  async flush() {
    await this.ready;
    await this.writeChain;
  }

  async close() {
    try {
      await this.flush();
    } finally {
      await this.pool.end?.();
    }
  }
}

module.exports = { PostgresStateStore, STATE_VERSION };
