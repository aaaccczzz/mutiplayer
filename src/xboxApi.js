const { parse: parseBigJson } = require('json-bigint')({ storeAsString: true });

const SESSION_DIRECTORY = 'https://sessiondirectory.xboxlive.com';
const PROFILE_SERVICE = 'https://profile.xboxlive.com';
const PEOPLEHUB_SERVICE = 'https://peoplehub.xboxlive.com';
const HUA_IDENTITY_HANDLES = `${SESSION_DIRECTORY}/handles/query?include=relatedInfo,customProperties`;

class XboxApiError extends Error {
  constructor(message, { status = null, body = '' } = {}) {
    super(message);
    this.name = 'XboxApiError';
    this.status = status;
    this.body = body;
  }
}

function parseJsonBig(text) {
  if (text === undefined || text === null) return undefined;
  const trimmed = String(text).trim();
  if (!trimmed) return undefined;
  return parseBigJson(trimmed);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, message) {
  if (!ms || ms <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new XboxApiError(message)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

function isRetryableNetworkError(error) {
  if (!error) return false;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return false;
  return error instanceof TypeError || error.name === 'FetchError';
}

function retryDelayMs(response, attempt) {
  const retryAfterMs = Number.parseFloat(response.headers.get('x-ms-retry-after-ms') ?? '');
  if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return Math.min(retryAfterMs, 5000);
  }

  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number.parseFloat(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, 5000);
    }
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) {
      return Math.min(Math.max(0, date - Date.now()), 5000);
    }
  }

  return Math.min(500 * (attempt + 1) + Math.floor(Math.random() * 250), 5000);
}

class XboxApi {
  constructor({ authflow, config, fetchImpl = fetch }) {
    if (!authflow) throw new TypeError('XboxApi requires an authflow');
    if (!config) throw new TypeError('XboxApi requires a config');
    this.authflow = authflow;
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.auth = null;
    this.authPromise = null;
    this.stats = { requests: 0, retries: 0, status429: 0 };
  }

  async getAuthorization() {
    if (this.auth) return this.auth;
    if (!this.authPromise) {
      this.authPromise = withTimeout(
        this.authflow.getXboxToken('http://xboxlive.com'),
        this.config.httpTimeoutMs,
        '取得 Xbox token 逾時'
      ).then((token) => {
        if (!token?.userHash || !token?.XSTSToken) {
          throw new XboxApiError('Xbox token 缺少 userHash 或 XSTSToken');
        }
        this.auth = {
          header: `XBL3.0 x=${token.userHash};${token.XSTSToken}`,
          xuid: token.userXUID != null ? String(token.userXUID) : null
        };
        return this.auth;
      }).finally(() => {
        this.authPromise = null;
      });
    }
    return this.authPromise;
  }

  resetAuthorization() {
    this.auth = null;
    this.authPromise = null;
  }

  async requestJson(url, { method = 'GET', body, contractVersion, timeoutMs, signal, sign = false, headers: extraHeaders } = {}) {
    const requestTimeout = timeoutMs ?? this.config.httpTimeoutMs;
    const signals = [AbortSignal.timeout(requestTimeout)];
    if (signal) signals.push(signal);
    const combinedSignal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    const payload = body !== undefined ? JSON.stringify(body) : undefined;

    let lastError;
    for (let attempt = 0; attempt <= 2; attempt++) {
      try {
        const auth = await this.getAuthorization();
        const headers = {
          authorization: auth.header,
          accept: 'application/json',
          'accept-language': 'en-US',
          'user-agent': 'xbox-friend-rooms/1.0'
        };
        if (contractVersion) headers['x-xbl-contract-version'] = contractVersion;
        if (payload !== undefined) headers['content-type'] = 'application/json; charset=utf-8';
        if (sign) {
          const xbl = this.authflow?.xbl;
          if (!xbl || typeof xbl.sign !== 'function') {
            throw new XboxApiError('Xbox API 簽章失敗：authflow 不支援簽章');
          }
          headers.Signature = 'AAAAAQHddBl4ue190OP5DTwgCCgIT2epYBrrzihRGNRt8XWB8RlL2h92I8zCvTEqID58cIA90iYzDXdDrUD9TGM62i0U7Bd8jv60zw==';
        }
        if (extraHeaders) {
          for (const [key, value] of Object.entries(extraHeaders)) {
            headers[key.toLowerCase()] = value;
          }
        }

        this.stats.requests += 1;
        const response = await this.fetchImpl(url, {
          method,
          headers,
          signal: combinedSignal,
          redirect: 'error',
          body: payload
        });
        const text = await response.text();

        if (!response.ok) {
          if (response.status === 429) this.stats.status429 += 1;

          const isAuthRetry = response.status === 401 && attempt === 0;
          const isStatusRetry = isRetryableStatus(response.status) &&
            (response.status === 429 ? attempt < 2 : attempt < 1);

          if (isAuthRetry || isStatusRetry) {
            this.stats.retries += 1;
            if (isAuthRetry) this.resetAuthorization();
            await sleep(isAuthRetry ? 0 : retryDelayMs(response, attempt));
            continue;
          }

          throw new XboxApiError(
            `Xbox API ${method} ${url} -> HTTP ${response.status}${text ? `: ${text.slice(0, 500)}` : ''}`,
            {
              status: response.status,
              body: text.slice(0, 500)
            }
          );
        }

        return parseJsonBig(text);
      } catch (error) {
        lastError = error;
        if (error instanceof XboxApiError) {
          if (error.status === null && attempt < 1) {
            this.stats.retries += 1;
            await sleep(300);
            continue;
          }
          throw error;
        }
        if (isRetryableNetworkError(error) && attempt < 1) {
          this.stats.retries += 1;
          await sleep(300);
          continue;
        }
        throw new XboxApiError(`Xbox API ${method} ${url} 請求失敗: ${error.message}`);
      }
    }
    throw lastError;
  }

  async getProfile(identifier = 'me') {
    let user;
    if (identifier === 'me') {
      user = 'me';
    } else if (typeof identifier === 'string' && /^\d+$/.test(identifier)) {
      user = `xuid(${identifier})`;
    } else if (typeof identifier === 'string' && identifier) {
      user = `gt(${encodeURIComponent(identifier)})`;
    } else {
      throw new TypeError('getProfile 需要 me、xuid 或 gamertag');
    }

    const response = await this.requestJson(
      `${PROFILE_SERVICE}/users/${user}/settings?settings=Gamertag,GameDisplayName,GameDisplayPicRaw`,
      { contractVersion: this.config.profileContractVersion }
    );

    const profile = response?.profileUsers?.[0];
    if (!profile) throw new XboxApiError('無法取得 Xbox 個人資料');

    const settings = Object.fromEntries(
      (profile.settings || []).map(({ id, value }) => [id, value])
    );
    const xuid = profile.id != null ? String(profile.id) : null;
    if (!xuid) throw new XboxApiError('Xbox 個人資料缺少 XUID');

    return {
      xuid,
      gamertag: settings.Gamertag || settings.GameDisplayName || xuid
    };
  }

  async queryActivityHandles(owners) {
    if (!owners || typeof owners !== 'object') {
      throw new TypeError('queryActivityHandles 需要 owners 物件');
    }

    const response = await this.requestJson(HUA_IDENTITY_HANDLES, {
      method: 'POST',
      contractVersion: this.config.contractVersion,
      body: {
        type: 'activity',
        scid: this.config.scid,
        owners
      }
    });

    if (Array.isArray(response)) return response;
    return Array.isArray(response?.results) ? response.results : [];
  }

  async getSession(name) {
    if (!name) throw new TypeError('getSession 需要 session 名稱');
    const url = `${SESSION_DIRECTORY}/serviceconfigs/${encodeURIComponent(this.config.scid)}/sessionTemplates/${encodeURIComponent(this.config.templateName)}/sessions/${encodeURIComponent(name)}`;
    return this.requestJson(url, { contractVersion: this.config.contractVersion });
  }

  async sendInvite(sessionName, invitedXuid) {
    if (!sessionName) throw new TypeError('sendInvite 需要 session 名稱');
    if (!/^\d+$/.test(String(invitedXuid ?? ''))) {
      throw new TypeError('sendInvite 需要有效的 invitedXuid');
    }

    return this.requestJson(`${SESSION_DIRECTORY}/handles`, {
      method: 'POST',
      contractVersion: this.config.contractVersion,
      sign: true,
      headers: {
        'accept-language': 'zh-TW,zh,zh-TW,zh',
        'user-agent': 'XboxServicesAPI/2025.10.20260402.0 c'
      },
      body: {
        type: 'invite',
        sessionRef: {
          scid: this.config.scid,
          templateName: this.config.templateName,
          name: sessionName
        },
        version: 1,
        invitedXuid: String(invitedXuid),
        inviteAttributes: {
          titleId: String(this.config.inviteTitleId)
        }
      }
    });
  }

  async listFriends() {
    const response = await this.requestJson(
      `${PEOPLEHUB_SERVICE}/users/me/people/social/decoration/detail,preferredColor,follower`,
      { contractVersion: this.config.socialContractVersion }
    );

    const people = Array.isArray(response?.people) ? response.people : [];
    return people
      .map((person) => ({
        xuid: person?.xuid != null ? String(person.xuid) : null,
        gamertag: person?.gamertag || person?.displayName || person?.modernGamertag || ''
      }))
      .filter((person) => person.xuid);
  }
}

function createXboxApi(options) {
  return new XboxApi(options);
}

module.exports = {
  XboxApi,
  XboxApiError,
  createXboxApi,
  parseJsonBig
};
