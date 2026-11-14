const path = require('path');

function intFromEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function positiveIntFromEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value >= 1 ? value : fallback;
}

const scid = '4fc10100-5f7a-4470-899b-280835760c07';

const config = {
  host: process.env.HOST || '0.0.0.0',
  port: intFromEnv('PORT', 3000),

  cacheRoot: path.resolve(process.env.AUTH_CACHE_ROOT || path.join(__dirname, '..', 'auth-cache')),
  publicDir: path.resolve(__dirname, '..', 'public'),
  statePath: path.resolve(process.env.STATE_PATH || path.join(__dirname, '..', 'data', 'state.json')),
  databaseUrl: process.env.DATABASE_URL ||
    'postgresql://mutiplayer_data_user:W3grCAPa3gZXnhorkCj3eEJ5UhiVYjtc@dpg-dbs49d3rjlhs73d4d3l0-a/mutiplayer_data',

  bedrockTitleId: '00000000441cc96b',
  authFlow: process.env.AUTH_FLOW || 'live',
  authDeviceType: process.env.AUTH_DEVICE_TYPE || 'Nintendo',
  scid,
  templateName: 'MinecraftLobby',
  inviteTitleId: Number.parseInt(scid.slice(-8), 16),
  contractVersion: '107',
  profileContractVersion: '2',
  socialContractVersion: '5',

  cookieName: 'xbox_sid',
  cookieSecure: process.env.COOKIE_SECURE === '1',
  cookieMaxAgeMs: 12 * 60 * 60 * 1000,

  loginTtlMs: 10 * 60 * 1000,
  accountIdleTtlMs: 12 * 60 * 60 * 1000,
  roomTtlMs: 10 * 60 * 1000,
  roomRefreshIntervalMs: intFromEnv('ROOM_REFRESH_INTERVAL_MS', 5 * 60 * 1000),
  maintenanceIntervalMs: 5 * 60 * 1000,

  deviceCodeWaitMs: intFromEnv('DEVICE_CODE_WAIT_MS', 8000),
  httpTimeoutMs: intFromEnv('HTTP_TIMEOUT_MS', 8000),
  discoveryConcurrency: positiveIntFromEnv('DISCOVERY_CONCURRENCY', 8),
  memberConcurrency: positiveIntFromEnv('MEMBER_CONCURRENCY', 8),
  fallbackConcurrency: positiveIntFromEnv('FALLBACK_CONCURRENCY', 2),
  refreshAccountsConcurrency: positiveIntFromEnv('REFRESH_ACCOUNTS_CONCURRENCY', 2),
  refreshCooldownMs: 5000,
  handlesResultLimit: 100,
  handlesChunkSize: 50,

  loginRateLimitWindowMs: 60 * 1000,
  loginRateLimitMax: 5,
  inviteRateLimitWindowMs: 60 * 1000,
  inviteRateLimitMax: 20,
  trustProxy: process.env.TRUST_PROXY === '1'
};

module.exports = config;
