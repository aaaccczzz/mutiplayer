const path = require('path');
const express = require('express');
const config = require('./src/config');
const { AuthManager } = require('./src/auth');
const { RoomRefresher } = require('./src/roomRefresher');
const { createRouter } = require('./src/routes');

const logger = console;

const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', 1);

app.use(express.json({ limit: '16kb' }));

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'"
    ].join('; ')
  });
  next();
});

app.use(express.static(config.publicDir, {
  index: 'index.html',
  setHeaders(res, filePath) {
    if (path.basename(filePath) === 'index.html') res.set('Cache-Control', 'no-cache');
  }
}));

const auth = new AuthManager(config, { logger });
const refresher = new RoomRefresher({ auth, config, logger });
app.use('/api', createRouter({ auth, config, logger, refresher }));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: '找不到 API 端點' });
  }
  res.status(404).type('text/plain').send('Not Found');
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);

  if (error.type === 'entity.parse.failed') {
    logger.warn(`[http] ${req.method} ${req.originalUrl} -> 400 無效的 JSON`);
    return res.status(400).json({ error: '請求內容不是有效的 JSON' });
  }

  if (error.code === 'DEVICE_CODE_UNAVAILABLE') {
    logger.warn(`[http] ${req.method} ${req.originalUrl} -> 502 ${error.message}`);
    return res.status(502).json({ error: `無法開始登入：${error.message}` });
  }

  const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600
    ? error.status
    : 500;

  if (status >= 500) {
    logger.error(`[http] ${req.method} ${req.originalUrl} -> ${error.stack || error.message}`);
  } else {
    logger.warn(`[http] ${req.method} ${req.originalUrl} -> ${status} ${error.message}`);
  }

  res.status(status).json({ error: status === 500 ? '伺服器發生錯誤' : error.message });
});

const maintenance = setInterval(() => {
  auth.prune().catch((error) => logger.warn(`[auth] 維護失敗：${error.message}`));
}, config.maintenanceIntervalMs);
maintenance.unref();

const server = app.listen(config.port, config.host, () => {
  logger.log(`Xbox 好友世界已啟動：http://${config.host}:${config.port}`);
});
refresher.start();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.log(`收到 ${signal}，正在關閉…`);
  clearInterval(maintenance);
  refresher.stop();
  server.close();
  const force = setTimeout(() => process.exit(1), 10000);
  force.unref();
  try {
    await auth.shutdown();
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', () => { shutdown('SIGINT'); });
process.on('SIGTERM', () => { shutdown('SIGTERM'); });

module.exports = { app, server, auth, refresher };
