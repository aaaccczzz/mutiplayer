const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../src/config');
const { XboxApi } = require('../src/xboxApi');

const authflow = {
  async getXboxToken() {
    return {
      userHash: 'user-hash',
      XSTSToken: 'xsts-token',
      userXUID: '2535400000000001'
    };
  },
  xbl: {
    sign(url, authorizationToken, payload) {
      return Buffer.from(JSON.stringify({ url, authorizationToken, payload }));
    }
  }
};

function makeResponse({ ok = true, status = 200, body = {} } = {}) {
  return {
    ok,
    status,
    text: async () => (ok ? JSON.stringify(body) : JSON.stringify(body))
  };
}

test('sendInvite 使用 invite handle 呼叫 session directory', async () => {
  const requests = [];
  const api = new XboxApi({
    authflow,
    config,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return makeResponse({ body: { handle: 'invite-handle' } });
    }
  });

  const result = await api.sendInvite('8A9BB18C-0048-412B-ACE4-439F6A8909FB', '2535420081824553');

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://sessiondirectory.xboxlive.com/handles');
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.headers['x-xbl-contract-version'], config.contractVersion);
  assert.equal(requests[0].options.headers['content-type'], 'application/json; charset=utf-8');
  assert.ok(requests[0].options.headers.Signature);

  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.type, 'invite');
  assert.equal(body.sessionRef.scid, config.scid);
  assert.equal(body.sessionRef.templateName, config.templateName);
  assert.equal(body.sessionRef.name, '8A9BB18C-0048-412B-ACE4-439F6A8909FB');
  assert.equal(body.version, 1);
  assert.equal(body.invitedXuid, '2535420081824553');
  assert.equal(body.inviteAttributes.titleId, String(config.inviteTitleId));

  assert.equal(result.handle, 'invite-handle');
});

test('sendInvite 拒絕缺少或無效的參數', async () => {
  const api = new XboxApi({
    authflow,
    config,
    fetchImpl: async () => makeResponse()
  });

  await assert.rejects(
    api.sendInvite('', '2535420081824553'),
    /session 名稱/
  );
  await assert.rejects(
    api.sendInvite('session-1', 'not-a-xuid'),
    /invitedXuid/
  );
});
