(() => {
  'use strict';

  const elements = {
    accountBar: document.getElementById('account-bar'),
    accountName: document.getElementById('account-name'),
    broadcastToggle: document.getElementById('broadcast-toggle'),
    refreshButton: document.getElementById('refresh-button'),
    logoutButton: document.getElementById('logout-button'),
    deleteAccountButton: document.getElementById('delete-account-button'),
    loginView: document.getElementById('login-view'),
    loginButton: document.getElementById('login-button'),
    deviceCodeBox: document.getElementById('device-code-box'),
    verifyLink: document.getElementById('verify-link'),
    userCode: document.getElementById('user-code'),
    loginStatus: document.getElementById('login-status'),
    roomsView: document.getElementById('rooms-view'),
    rooms: document.getElementById('rooms'),
    errorBanner: document.getElementById('error-banner')
  };

  const AUTO_REFRESH_MS = 60 * 1000;
  const WARM_POLL_MS = 2000;
  const TRUST_ISSUE_LABELS = {
    'host-missing': '主機不在玩家名單',
    'count-mismatch': '回報人數與玩家名單不符'
  };
  const state = { loggedIn: false, profile: null, broadcastEnabled: false, showUntrusted: false };
  let lastRoomsData = null;
  let loginPollTimer = null;
  let autoRefreshTimer = null;
  let warmPollTimer = null;
  let errorTimer = null;
  let pollingLogin = false;

  try {
    state.showUntrusted = localStorage.getItem('showUntrusted') === '1';
  } catch {
    state.showUntrusted = false;
  }

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null) continue;
      if (key === 'text') node.textContent = value;
      else if (key === 'className') node.className = value;
      else if (key === 'hidden') node.hidden = Boolean(value);
      else if (key === 'disabled') node.disabled = Boolean(value);
      else node.setAttribute(key, String(value));
    }
    node.append(...children.filter((child) => child !== null && child !== undefined));
    return node;
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      credentials: 'same-origin',
      headers: { accept: 'application/json', ...(options.headers || {}) }
    });

    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }

    if (!response.ok) {
      const error = new Error(body?.error || `請求失敗（HTTP ${response.status}）`);
      error.status = response.status;
      throw error;
    }
    return body;
  }

  function showError(message) {
    elements.errorBanner.textContent = message;
    elements.errorBanner.hidden = false;
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => {
      elements.errorBanner.hidden = true;
    }, 8000);
  }

  function formatTime(isoString) {
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return '未知時間';
    return date.toLocaleString('zh-TW', { hour12: false });
  }

  function formatMembers(current, max) {
    if (current === null || current === undefined) {
      return max === null || max === undefined ? '—' : `? / ${max}`;
    }
    return max === null || max === undefined ? String(current) : `${current} / ${max}`;
  }

  function fact(label, value) {
    return el('div', { className: 'fact' },
      el('span', { className: 'fact-label' }, label),
      el('span', { className: 'fact-value' }, value)
    );
  }

  function renderConnection(connection) {
    const row = el('div', { className: 'connection' });
    const transport = connection.transport === 'webrtc' ? 'WebRTC' : 'NetherNet';
    row.append(
      el('span', { className: `transport ${connection.transport}` }, transport),
      el('span', { className: 'connection-id' }, el('code', {}, connection.netherNetId))
    );

    if (connection.pmsgId) {
      row.append(el('span', { className: 'pmsg' }, 'pmsg ', el('code', {}, connection.pmsgId)));
    }
    if (connection.connectionType !== null && connection.connectionType !== undefined) {
      row.append(el('span', { className: 'meta' }, `type ${connection.connectionType}`));
    }

    const copyButton = el('button', { type: 'button', className: 'copy' }, '複製 ID');
    copyButton.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(connection.netherNetId);
        copyButton.textContent = '已複製';
        setTimeout(() => { copyButton.textContent = '複製 ID'; }, 1500);
      } catch {
        copyButton.textContent = '複製失敗';
      }
    });
    row.append(copyButton);
    return row;
  }

  function renderMembers(session) {
    const members = Array.isArray(session.members) ? session.members : [];
    const info = session.membersInfo || {};
    const accepted = info.accepted ?? session.memberCount ?? members.length;
    const active = info.active ?? members.filter((member) => member.active).length;

    const details = el('details', { className: 'members' });
    if (session.membersError) details.open = true;

    details.append(el('summary', { className: 'members-summary' }, `玩家（${active} 遊戲中 / ${accepted} 人）`));

    const body = el('div', { className: 'members-body' });

    const broadcasters = (session.broadcasters || [])
      .map((item) => item.gamertag || item.xuid || '未知帳號');
    if (broadcasters.length) {
      body.append(el('p', { className: 'host broadcasters' }, '廣播者：', el('strong', {}, broadcasters.join('、'))));
    }

    if (session.membersError) {
      body.append(el('p', { className: 'inline-error' }, `玩家名單：${session.membersError}`));
    }
    if (session.membersIncomplete) {
      body.append(el('p', { className: 'meta' }, '玩家名單可能不完整'));
    }
    if (members.length === 0) {
      if (!session.membersError) {
        body.append(el('p', { className: 'muted member-empty' }, '尚未取得玩家名單。'));
      }
      details.append(body);
      return details;
    }

    const list = el('ul', { className: 'member-list' });
    for (const member of members) {
      const item = el('li', {
        className: member.active ? 'member active' : 'member',
        title: member.xuid || ''
      },
      el('span', { className: 'member-dot' }),
      el('span', { className: 'member-name' }, member.gamertag || member.xuid || '未知玩家'));
      list.append(item);
    }
    body.append(list);
    details.append(body);
    return details;
  }

  function renderInvite(session) {
    if (session.closed) return null;
    const sender = (session.broadcasters || []).find((item) => item?.id);
    if (!sender?.id) return null;
    const senderName = sender.gamertag || sender.xuid || '廣播者';

    const placeholder = state.loggedIn ? '訪客 XUID/gamertag（可留空）' : '你的 XUID/gamertag';
    const input = el('input', {
      type: 'text',
      className: 'invite-input',
      placeholder,
      'aria-label': placeholder,
      autocomplete: 'off'
    });
    const button = el('button', { type: 'submit', className: 'invite-button' }, '邀請');
    const status = el('span', { className: 'invite-status', 'aria-live': 'polite' });
    const form = el('form', { className: 'invite' }, input, button, status);

    form.addEventListener('submit', async (event) => {
      event.preventDefault();

      const guestTarget = input.value.trim();
      if (!guestTarget && !state.loggedIn) {
        status.textContent = '請先輸入你的 XUID 或 gamertag';
        status.className = 'invite-status error';
        return;
      }

      button.disabled = true;
      input.disabled = true;
      status.textContent = guestTarget ? '傳送邀請中…' : '自動邀請自己…';
      status.className = 'invite-status';

      try {
        await api(
          `/api/rooms/${encodeURIComponent(session.sessionName)}/invite`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ target: guestTarget, accountId: sender.id })
          }
        );
        status.textContent = `邀請已送出（由 ${senderName} 發出）`;
        status.className = 'invite-status ok';
        input.value = '';
      } catch (error) {
        status.textContent = error.message;
        status.className = 'invite-status error';
      } finally {
        button.disabled = false;
        input.disabled = false;
      }
    });

    return form;
  }

  function trustIssueText(session) {
    return (session.trustIssues || []).map((issue) => TRUST_ISSUE_LABELS[issue] || issue).join('、');
  }

  function renderSession(session) {
    const title = el('h3', {}, session.worldName || '未知世界');
    if (session.closed) title.append(el('span', { className: 'badge closed' }, '已關閉'));
    if (session.trusted === false) {
      title.append(el('span', {
        className: 'badge untrusted',
        title: trustIssueText(session)
      }, '不信任'));
    }

    const sender = (session.broadcasters || []).find((item) => item?.id);
    const senderName = sender?.gamertag || sender?.xuid || '廣播者';

    const facts = el('div', { className: 'facts' },
      fact('版本', session.version || '—'),
      fact('人數', formatMembers(session.memberCount, session.maxMemberCount)),
      fact('加入方式', session.joinability || '—')
    );
    if (session.visibility) facts.append(fact('可見性', session.visibility));

    const connections = el('div', { className: 'connections' });
    for (const connection of session.connections || []) {
      connections.append(renderConnection(connection));
    }

    const card = el('article', {
      className: session.trusted === false ? 'session untrusted' : 'session'
    },
    title,
    el('p', { className: 'host' }, '主機：', el('strong', {}, session.hostName || '未知')),
    facts,
    renderMembers(session)
    );

    if (session.trusted === false) {
      card.append(el('p', { className: 'meta untrusted-reasons' },
        `未通過信任檢查：${trustIssueText(session) || '未知原因'}`));
    }

    const inviteForm = renderInvite(session);
    if (inviteForm) {
      if (state.loggedIn) {
        card.append(
          el('p', { className: 'invite-hint' }, `本次會收到名稱為「${senderName}」的邀請，請同意。`),
          el('p', { className: 'invite-hint muted' }, '留空＝自動邀請自己；輸入訪客資料＝邀請訪客。'),
          inviteForm
        );
      } else {
        card.append(
          el('p', { className: 'invite-hint' }, `輸入你的 XUID/gamertag，由「${senderName}」發送邀請給你。`),
          inviteForm
        );
      }
    }

    card.append(connections);
    return card;
  }

  function renderAccountsSummary(accounts) {
    const bar = el('div', { className: 'broadcaster-bar' });
    bar.append(el('h2', { className: 'broadcaster-title' }, '廣播帳號'));

    const chips = el('div', { className: 'broadcaster-chips' });
    for (const account of accounts) {
      const chip = el('span', {
        className: 'broadcaster-chip',
        title: account.error ? `更新失敗：${account.error}` : (account.updatedAt ? `更新於 ${formatTime(account.updatedAt)}` : '尚未更新')
      },
      el('span', { className: 'chip-name' }, account.gamertag || account.xuid || '未知帳號'),
      el('span', { className: 'chip-count' }, `${account.sessionCount} 房`));
      if (account.refreshing) chip.append(el('span', { className: 'badge refreshing' }, '更新中'));
      if (account.stale) chip.append(el('span', { className: 'badge stale' }, '可能過期'));
      if (account.error) chip.classList.add('error');
      chips.append(chip);
    }

    bar.append(chips);
    for (const account of accounts) {
      if (account.error) {
        bar.append(el('p', { className: 'inline-error' }, `${account.gamertag || '帳號'}：更新失敗 ${account.error}`));
      }
    }
    return bar;
  }

  function renderUntrustedToggle(count) {
    const button = el('button', {
      type: 'button',
      className: 'untrusted-toggle secondary'
    }, state.showUntrusted ? `隱藏不信任房間（${count}）` : `顯示不信任房間（${count}）`);
    button.addEventListener('click', () => {
      state.showUntrusted = !state.showUntrusted;
      try {
        localStorage.setItem('showUntrusted', state.showUntrusted ? '1' : '0');
      } catch {
        // 忽略儲存失敗，僅影響下次是否記住設定。
      }
      if (lastRoomsData) renderRooms(lastRoomsData);
    });
    return button;
  }

  function renderRooms(data) {
    lastRoomsData = data;
    const rooms = data?.rooms || [];
    const accounts = data?.accounts || [];
    const untrustedCount = rooms.filter((room) => room.trusted === false).length;
    const visibleRooms = state.showUntrusted
      ? rooms
      : rooms.filter((room) => room.trusted !== false);

    elements.rooms.replaceChildren();
    if (accounts.length > 0) elements.rooms.append(renderAccountsSummary(accounts));
    if (untrustedCount > 0) elements.rooms.append(renderUntrustedToggle(untrustedCount));

    if (!visibleRooms.length) {
      const message = accounts.length === 0
        ? '目前沒有已登入的廣播帳號，登入後即可分享好友房間。'
        : rooms.length > 0
          ? '所有房間都未通過信任檢查，可展開上方按鈕查看。'
          : '目前沒有可加入的房間。';
      elements.rooms.append(el('p', { className: 'muted empty' }, message));
      return;
    }

    const list = el('div', { className: 'session-list standalone' });
    for (const session of visibleRooms) list.append(renderSession(session));
    elements.rooms.append(list);
  }

  function stopWarmPoll() {
    if (warmPollTimer) {
      clearTimeout(warmPollTimer);
      warmPollTimer = null;
    }
  }

  function scheduleWarmPoll() {
    if (warmPollTimer) return;
    warmPollTimer = setTimeout(async () => {
      warmPollTimer = null;
      if (document.hidden) return;
      try {
        await loadRooms();
      } catch (error) {
        if (error.status === 401) return showLoggedOut();
        showError(error.message);
      }
    }, WARM_POLL_MS);
  }

  async function loadRooms() {
    const data = await api('/api/rooms');
    renderRooms(data);
    if (data?.refreshing) scheduleWarmPoll();
    else stopWarmPoll();
  }

  function stopLoginPoll() {
    if (loginPollTimer) {
      clearInterval(loginPollTimer);
      loginPollTimer = null;
    }
  }

  function stopAutoRefresh() {
    if (autoRefreshTimer) {
      clearInterval(autoRefreshTimer);
      autoRefreshTimer = null;
    }
  }

  function startAutoRefresh() {
    stopAutoRefresh();
    autoRefreshTimer = setInterval(() => {
      if (document.hidden) return;
      loadRooms().catch((error) => {
        if (error.status === 401) showLoggedOut();
      });
    }, AUTO_REFRESH_MS);
  }

  function showLoggedOut(message = '') {
    stopLoginPoll();
    stopAutoRefresh();
    stopWarmPoll();
    state.loggedIn = false;
    state.profile = null;
    elements.accountBar.hidden = true;
    elements.roomsView.hidden = true;
    elements.rooms.replaceChildren();
    elements.loginView.hidden = false;
    elements.deviceCodeBox.hidden = true;
    elements.userCode.textContent = '';
    elements.loginStatus.textContent = message;
    elements.loginButton.disabled = false;
  }

  function showVisitor(message = '') {
    stopLoginPoll();
    state.loggedIn = false;
    state.profile = null;
    elements.accountBar.hidden = true;
    elements.loginView.hidden = false;
    elements.deviceCodeBox.hidden = true;
    elements.userCode.textContent = '';
    elements.loginStatus.textContent = message;
    elements.loginButton.disabled = false;
    elements.roomsView.hidden = false;
    startAutoRefresh();
  }

  function updateBroadcastToggle(enabled) {
    state.broadcastEnabled = enabled;
    elements.broadcastToggle.textContent = enabled ? '廣播好友房間：開' : '廣播好友房間：關';
    elements.broadcastToggle.classList.toggle('on', enabled);
  }

  async function toggleBroadcast() {
    const next = !state.broadcastEnabled;
    elements.broadcastToggle.disabled = true;
    try {
      const data = await api('/api/me/broadcast', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: next })
      });
      updateBroadcastToggle(Boolean(data.broadcastEnabled));
      loadRooms().catch(() => {});
    } catch (error) {
      showError(error.message);
    } finally {
      elements.broadcastToggle.disabled = false;
    }
  }

  function showLoggedIn(profile) {
    stopAutoRefresh();
    state.loggedIn = true;
    state.profile = profile;
    elements.accountName.textContent = profile.gamertag || profile.xuid || '已登入';
    updateBroadcastToggle(profile.broadcastEnabled === true);
    elements.accountBar.hidden = false;
    elements.loginView.hidden = true;
    elements.roomsView.hidden = false;
    startAutoRefresh();
  }

  async function boot() {
    let profile = null;
    try {
      profile = await api('/api/me');
    } catch (error) {
      if (error.status !== 401) showError(error.message);
    }

    if (profile) showLoggedIn(profile);
    else showVisitor();

    try {
      await loadRooms();
    } catch (error) {
      showError(error.message);
    }
  }

  async function pollLogin(loginId) {
    if (pollingLogin) return;
    pollingLogin = true;

    try {
      const data = await api(`/api/login/status/${encodeURIComponent(loginId)}`);
      if (data.status === 'success') {
        stopLoginPoll();
        elements.loginStatus.textContent = '登入成功，正在載入房間…';
        await boot();
      } else if (data.status !== 'pending') {
        stopLoginPoll();
        elements.loginButton.disabled = false;
        elements.loginStatus.textContent = data.error || '登入失敗';
      }
    } catch (error) {
      if (error.status === 404 || error.status === 410) {
        stopLoginPoll();
        elements.loginButton.disabled = false;
        elements.loginStatus.textContent = error.message;
      } else {
        elements.loginStatus.textContent = `等待登入中…（${error.message}）`;
      }
    } finally {
      pollingLogin = false;
    }
  }

  async function startLogin() {
    stopLoginPoll();
    elements.loginButton.disabled = true;
    elements.loginStatus.textContent = '正在取得裝置碼…';

    try {
      const data = await api('/api/login/start', { method: 'POST' });
      elements.userCode.textContent = data.userCode || '—';
      elements.verifyLink.href = data.verificationUri || 'https://www.microsoft.com/link';
      elements.verifyLink.textContent = data.verificationUri || 'Microsoft 裝置登入頁面';
      elements.deviceCodeBox.hidden = false;

      const minutes = data.expiresIn ? Math.max(1, Math.round(data.expiresIn / 60)) : 15;
      elements.loginStatus.textContent = `請在 ${minutes} 分鐘內完成登入，完成後會自動更新。`;
      loginPollTimer = setInterval(() => pollLogin(data.loginId), 3000);
      pollLogin(data.loginId);
    } catch (error) {
      elements.loginButton.disabled = false;
      elements.loginStatus.textContent = error.message;
    }
  }

  async function refresh() {
    elements.refreshButton.disabled = true;
    elements.refreshButton.textContent = '更新中…';

    try {
      const data = await api('/api/refresh', { method: 'POST' });
      renderRooms(data);
      if (data?.refreshing) scheduleWarmPoll();
      else stopWarmPoll();
      if (data?.errors?.length) {
        showError(data.errors
          .map((item) => `${item.gamertag || '帳號'}：${item.error}`)
          .join('；'));
      }
    } catch (error) {
      if (error.status === 401) {
        showVisitor('登入已過期，目前以訪客模式瀏覽。');
        loadRooms().catch(() => {});
        return;
      }
      showError(error.message);
    } finally {
      elements.refreshButton.disabled = false;
      elements.refreshButton.textContent = '重新整理';
    }
  }

  async function logout() {
    elements.logoutButton.disabled = true;
    try {
      await api('/api/logout', { method: 'POST' });
    } catch {
      // The session is cleared client-side below regardless.
    } finally {
      elements.logoutButton.disabled = false;
    }
    showVisitor('已登出。');
    loadRooms().catch(() => {});
  }

  async function deleteAccount() {
    if (!window.confirm('確定要註銷這個帳號嗎？')) return;

    elements.deleteAccountButton.disabled = true;
    try {
      await api('/api/account', { method: 'DELETE' });
    } catch {
      // Even if the server call fails, the local session is cleared below.
    } finally {
      elements.deleteAccountButton.disabled = false;
    }
    showVisitor('已註銷帳號。');
    loadRooms().catch(() => {});
  }

  elements.loginButton.addEventListener('click', startLogin);
  elements.broadcastToggle.addEventListener('click', toggleBroadcast);
  elements.refreshButton.addEventListener('click', refresh);
  elements.logoutButton.addEventListener('click', logout);
  elements.deleteAccountButton.addEventListener('click', deleteAccount);

  boot();
})();
