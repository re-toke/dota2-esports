// utils/realtime.js
// T4 WebSocket 实时比分连接层（客户端骨架）。
// 设计：优先 WebSocket（wss），断线指数退避重连，超过上限或后端不可用时自动降级为轮询。
// 后端契约见 README「实时比分后端契约」一节；未配置 wss 时直接使用轮询（无后端也能跑）。

const config = require('../../utils/config.js');

function getConf() {
  return (config && config.realtime) || {};
}

// 创建一场比赛的实时会话。
// handlers:
//   fetchPoll(): Promise<match>  —— 降级轮询时拉取最新比赛数据
//   onUpdate(match): void        —— 收到新数据时回调（直接重渲染）
//   onStatus(status): void       —— 'connected' | 'polling'
function createSession(matchId, handlers) {
  const conf = getConf();
  const url = conf.url || '';
  const pollInterval = conf.pollInterval || 30000;
  const heartbeat = conf.heartbeat || 25000;
  const maxReconnect = (conf.maxReconnect != null) ? conf.maxReconnect : 5;

  let socketTask = null;
  let heartbeatTimer = null;
  let reconnectTimer = null;
  let pollTimer = null;
  let pollingStarted = false;
  let reconnectCount = 0;
  let closed = false;

  function clearSocket() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    socketTask = null;
  }

  function stopPolling() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  }

  function send(obj) {
    try { if (socketTask) socketTask.send({ data: JSON.stringify(obj) }); } catch (e) {}
  }

  // ★★ 2026-10-29（B2）：**轮询递归调度**（上一次请求 settle 后才排下一次）。
  //   旧实现是 `setInterval(tick, 30s)`：单次请求若超过 30s（弱网 / EF 冷启动），
  //   下一次 tick 会叠加在上一次之上 ⇒ 请求越积越多、页面越刷越慢。
  //   现在：**串行**（永不叠请求）+ 失败也继续（间隔不变，避免退避导致比分停更）。
  //   ⚠️ 调用方的 `fetchPoll` 必须**回源**（`{ force: true }`）—— 否则命中本地缓存时
  //      永远看不到比分变化（见 match-detail.js 的 fetchPoll）。
  function startPolling() {
    if (pollingStarted || closed || !handlers.fetchPoll) return;
    pollingStarted = true;
    const tick = () => {
      if (closed) return;
      Promise.resolve()
        .then(() => handlers.fetchPoll())
        .then((m) => { if (m && !closed) handlers.onUpdate && handlers.onUpdate(m); })
        .catch(() => {})
        .then(() => { if (!closed) pollTimer = setTimeout(tick, pollInterval); });
    };
    tick();
  }

  function scheduleReconnect() {
    if (closed) return;
    if (reconnectCount >= maxReconnect) {
      // 重连耗尽 → 降级轮询
      handlers.onStatus && handlers.onStatus('polling');
      startPolling();
      return;
    }
    reconnectCount++;
    const delay = Math.min(30000, 1000 * Math.pow(2, reconnectCount));
    reconnectTimer = setTimeout(() => {
      if (!closed) openSocket();
    }, delay);
  }

  function openSocket() {
    if (!url || closed) { handlers.onStatus && handlers.onStatus('polling'); startPolling(); return; }
    let task;
    try {
      task = wx.connectSocket({
        url: url + (url.indexOf('?') >= 0 ? '&' : '?') + 'matchId=' + matchId,
        fail: () => {}
      });
    } catch (e) {
      handlers.onStatus && handlers.onStatus('polling');
      startPolling();
      return;
    }
    socketTask = task;

    task.onOpen(() => {
      reconnectCount = 0;
      handlers.onStatus && handlers.onStatus('connected');
      send({ type: 'subscribe', matchId: matchId });
      heartbeatTimer = setInterval(() => send({ type: 'ping' }), heartbeat);
    });

    task.onMessage((res) => {
      try {
        const msg = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
        // 后端推送格式：{ type: 'score', match: <OpenDota match 对象> }
        if (msg && msg.type === 'score' && msg.match) {
          handlers.onUpdate && handlers.onUpdate(msg.match);
        }
      } catch (e) {}
    });

    task.onClose(() => { clearSocket(); scheduleReconnect(); });
    task.onError(() => { clearSocket(); scheduleReconnect(); });
  }

  function close() {
    closed = true;
    clearSocket();
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    stopPolling();
    try { if (socketTask) socketTask.close({}); } catch (e) {}
    socketTask = null;
  }

  if (url) openSocket();
  else { handlers.onStatus && handlers.onStatus('polling'); startPolling(); }

  return {
    close: close,
    status: () => (socketTask ? 'connected' : 'polling')
  };
}

module.exports = { createSession };
