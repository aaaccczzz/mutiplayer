const {
  refreshAccounts,
  refreshAccount,
  apiForAccount
} = require('./rooms');

class RoomRefresher {
  constructor({
    auth,
    config,
    logger = console,
    refreshAll = refreshAccounts,
    refreshOne = refreshAccount,
    apiFactory = apiForAccount
  }) {
    this.auth = auth;
    this.config = config;
    this.logger = logger;
    this.refreshAll = refreshAll;
    this.refreshOne = refreshOne;
    this.apiFactory = apiFactory;
    this.timer = null;
    this.running = null;
    this.lastRunAt = null;
  }

  start() {
    if (this.timer) return;
    if (!(this.config.roomRefreshIntervalMs > 0)) return;

    this.timer = setInterval(() => {
      this.run().catch((error) => {
        this.logger.warn(`[refresh] 背景更新失敗：${error.message}`);
      });
    }, this.config.roomRefreshIntervalMs);
    this.timer.unref?.();

    this.run().catch((error) => {
      this.logger.warn(`[refresh] 初次更新失敗：${error.message}`);
    });
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async run() {
    if (this.running) return this.running;

    this.running = (async () => {
      const startedAt = Date.now();
      const accounts = this.auth.listAccounts()
        .filter((account) => account.broadcastEnabled === true);
      this.lastRunAt = startedAt;

      if (accounts.length === 0) {
        return { results: [], skipped: true };
      }

      const results = await this.refreshAll(accounts, {
        config: this.config,
        logger: this.logger,
        concurrency: this.config.refreshAccountsConcurrency
      });

      const ok = results.filter((result) => result.ok).length;
      const rooms = accounts.reduce((sum, account) => sum + (account.sessions?.length || 0), 0);
      const members = accounts.reduce((sum, account) => (
        sum + (account.sessions || []).reduce((count, session) => (
          count + (session.members?.length || 0)
        ), 0)
      ), 0);
      const memberErrors = accounts.reduce((sum, account) => (
        sum + (account.sessions || []).filter((session) => session.membersError).length
      ), 0);

      this.logger.log(
        `[refresh] accounts=${accounts.length} ok=${ok} rooms=${rooms} ` +
        `members=${members} memberErrors=${memberErrors} ms=${Date.now() - startedAt}`
      );
      this.auth.saveState?.();

      return { results, skipped: false };
    })().finally(() => {
      this.running = null;
    });

    return this.running;
  }

  async warmAccount(account) {
    if (!account) return null;
    try {
      const result = await this.refreshOne(
        account,
        this.apiFactory(account, this.config),
        this.config,
        this.logger
      );
      this.auth.saveState?.();
      return result;
    } catch {
      return null;
    }
  }
}

module.exports = { RoomRefresher };
