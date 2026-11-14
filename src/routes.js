const express = require('express');
const {
  getCookie,
  setSessionCookie,
  clearSessionCookie
} = require('./auth');
const {
  refreshAccounts,
  getMergedRoomsPayload,
  getAccountsSummary,
  apiForAccount
} = require('./rooms');

const LOGIN_ID_PATTERN = /^[0-9a-f-]{8,64}$/i;

function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function createRateLimiter({ windowMs, max, message }) {
  const attempts = new Map();

  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || req.socket?.remoteAddress || 'unknown';

    if (attempts.size > 5000) {
      for (const [ip, entry] of attempts) {
        if (now - entry.windowStart > windowMs) attempts.delete(ip);
      }
    }

    let entry = attempts.get(key);
    if (!entry || now - entry.windowStart >= windowMs) {
      entry = { count: 0, windowStart: now };
      attempts.set(key, entry);
    }
    entry.count += 1;

    if (entry.count > max) {
      const retryAfter = Math.max(1, Math.ceil((entry.windowStart + windowMs - now) / 1000));
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: message });
    }

    next();
  };
}

function loginRateLimiter(config) {
  return createRateLimiter({
    windowMs: config.loginRateLimitWindowMs,
    max: config.loginRateLimitMax,
    message: '登入請求過於頻繁，請稍後再試'
  });
}

function inviteRateLimiter(config) {
  return createRateLimiter({
    windowMs: config.inviteRateLimitWindowMs,
    max: config.inviteRateLimitMax,
    message: '邀請請求過於頻繁，請稍後再試'
  });
}

function requireAccount(auth) {
  return (req, res, next) => {
    const accountId = getCookie(req, auth.config.cookieName);
    const account = auth.getAccount(accountId);
    if (!account) {
      clearSessionCookie(res, auth.config);
      return res.status(401).json({ error: '尚未登入或工作階段已過期' });
    }
    req.account = account;
    next();
  };
}

function createRouter({ auth, config, logger = console, refresher }) {
  const router = express.Router();
  const requireLogin = requireAccount(auth);

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.post('/login/start', loginRateLimiter(config), wrap(async (req, res) => {
    const login = await auth.startLogin();
    res.json(login);
  }));

  router.get('/login/status/:loginId', wrap(async (req, res) => {
    const { loginId } = req.params;
    if (!LOGIN_ID_PATTERN.test(loginId)) {
      return res.status(404).json({ status: 'notfound', error: '登入流程不存在' });
    }

    const result = await auth.getLoginStatus(loginId);
    if (result.status === 'notfound') {
      return res.status(404).json({ status: 'notfound', error: '登入流程不存在或已過期' });
    }
    if (result.status === 'expired') {
      return res.status(410).json({ status: 'expired', error: '登入流程已過期，請重新登入' });
    }
    if (result.status === 'error') {
      return res.status(400).json({ status: 'error', error: result.error });
    }
    if (result.status === 'success') {
      setSessionCookie(res, config, result.account.id);
      if (refresher) refresher.warmAccount(result.account).catch(() => {});
      return res.json({ status: 'success', profile: result.profile, refreshing: true });
    }
    return res.json({ status: 'pending' });
  }));

  router.post('/logout', (req, res) => {
    clearSessionCookie(res, config);
    res.status(204).end();
  });

  router.delete('/account', requireLogin, wrap(async (req, res) => {
    auth.destroyAccount(req.account.id);
    clearSessionCookie(res, config);
    res.status(204).end();
  }));

  router.get('/me', requireLogin, (req, res) => {
    res.json({
      gamertag: req.account.profile?.gamertag || null,
      xuid: req.account.profile?.xuid || null
    });
  });

  router.get('/rooms', (req, res) => {
    const accounts = auth.listAccounts();

    res.json({
      rooms: getMergedRoomsPayload(accounts, config),
      accounts: getAccountsSummary(accounts, config),
      refreshing: accounts.some((account) => Boolean(account.discovering)),
      refreshIntervalMs: config.roomRefreshIntervalMs
    });
  });

  router.post('/refresh', requireLogin, wrap(async (req, res) => {
    const now = Date.now();
    const elapsed = now - req.account.lastRefreshAt;
    if (req.account.lastRefreshAt && elapsed < config.refreshCooldownMs) {
      const retryAfter = Math.max(1, Math.ceil((config.refreshCooldownMs - elapsed) / 1000));
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: `請等待 ${retryAfter} 秒後再重新整理` });
    }
    req.account.lastRefreshAt = now;

    const accounts = auth.listAccounts();
    const targets = accounts.length > 0 ? accounts : [req.account];
    const results = await refreshAccounts(targets, { config, logger });
    auth.saveState?.();
    const failures = results
      .filter((result) => !result.ok)
      .map((result) => ({
        gamertag: result.account.profile?.gamertag || null,
        error: result.error
      }));

    res.json({
      ok: failures.length === 0,
      errors: failures,
      rooms: getMergedRoomsPayload(targets, config),
      accounts: getAccountsSummary(targets, config),
      refreshing: targets.some((account) => Boolean(account.discovering))
    });
  }));

  function getViewerAccount(req) {
    const accountId = getCookie(req, config.cookieName);
    if (!accountId) return null;
    return auth.getAccount(accountId);
  }

  router.post('/rooms/:sessionName/invite', inviteRateLimiter(config), wrap(async (req, res) => {
    const sessionName = String(req.params.sessionName || '').trim();
    if (!sessionName || sessionName.length > 128) {
      return res.status(400).json({ error: '缺少有效的房間 session 名稱' });
    }

    const guestTarget = typeof req.body?.target === 'string' ? req.body.target.trim() : '';
    const viewer = getViewerAccount(req);
    const target = guestTarget
      || viewer?.profile?.gamertag
      || viewer?.profile?.xuid
      || '';
    if (!target) {
      return res.status(400).json({ error: '請輸入 XUID 或 gamertag' });
    }
    if (target.length > 64) {
      return res.status(400).json({ error: 'XUID 或 gamertag 格式無效' });
    }

    const accounts = auth.listAccounts();
    const requestedSenderId = typeof req.body?.accountId === 'string' ? req.body.accountId.trim() : '';
    const sender = (requestedSenderId && accounts.find((account) => account.id === requestedSenderId))
      || accounts[0];
    if (!sender) {
      return res.status(503).json({ error: '目前沒有可發送邀請的廣播帳號' });
    }

    const api = apiForAccount(sender, config);
    const invitedXuid = /^\d+$/.test(target)
      ? target
      : (await api.getProfile(target)).xuid;

    const senderLabel = sender.profile?.gamertag || sender.id;
    logger.log(`[invite] 準備發送邀請 sender=${senderLabel} ` +
      `senderXuid=${sender.profile?.xuid || '未知'} session=${sessionName} invitedXuid=${invitedXuid}`);

    try {
      const result = await api.sendInvite(sessionName, invitedXuid);
      logger.log(`[invite] 送出成功 sender=${senderLabel} ` +
        `session=${sessionName} invitedXuid=${invitedXuid} result=${JSON.stringify(result ?? null)}`);
      return res.json({
        ok: true,
        sessionName,
        invitedXuid,
        senderGamertag: sender.profile?.gamertag || null
      });
    } catch (error) {
      logger.warn(`[invite] 送出失敗 sender=${senderLabel} ` +
        `session=${sessionName} invitedXuid=${invitedXuid} error=${error.message}`);
      throw error;
    }
  }));

  return router;
}

module.exports = { createRouter };
