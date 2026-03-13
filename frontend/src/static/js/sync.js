// 这段脚本的目标：
// 让“本地播放器页面”始终和 Socket.IO 房间里共享的播放状态保持一致。
// 服务器维护一个权威状态（当前视频 URL、播放/暂停状态、播放位置、状态记录时间等），
// 客户端收到后会根据本地与服务器的时间差，尽量准确地推算“现在应该播到哪里”。


// 监听 DOMContentLoaded 事件：
// 只有当 HTML 文档已经被浏览器解析完成，DOM 元素都准备好之后，
// 我们才能安全地去 getElementById / 绑定事件 / 操作页面。
document.addEventListener('DOMContentLoaded', () => {

  // 检查 Socket.IO 客户端库是否已经被加载到页面上。
  // 正常情况下，如果页面中提前引入了 socket.io 的 script，
  // 那么浏览器全局对象 window 上会有一个 io。
  if (!window.io) {
    // 如果没有加载 Socket.IO，说明后续所有 socket 相关逻辑都无法运行。
    // 这里直接 return，避免继续执行后报错。
    return;
  }

  // 复用已有的全局 socket 连接：
  // 如果 window.appSocket 已存在，说明别的脚本已经创建过连接，
  // 这里直接拿来用，避免一个页面里重复创建多个 WebSocket / Socket.IO 连接。
  //
  // 如果不存在，就新建一个 Socket.IO 连接。
  // withCredentials: true 表示跨域通信时，允许携带 cookie / 凭证信息。
  // 这通常用于依赖 session / 登录态的后端服务。
  const socket = window.appSocket || io({ withCredentials: true });

  // 把 socket 存回 window，全局共享。
  // 这样其他脚本也可以复用这一条连接，而不是各建各的。
  window.appSocket = socket;


  // =========================
  // 获取页面中会用到的 DOM 元素
  // =========================

  // 用来显示当前播放器/连接状态的文本区域
  const statusEl = document.getElementById('video-message');

  // 播放按钮
  const playBtn = document.getElementById('play-btn');

  // 暂停按钮
  const pauseBtn = document.getElementById('pause-btn');

  // 跳转按钮（示例里固定跳到 10 秒）
  const seekBtn = document.getElementById('seek-btn');

  // 播放器容器：里面会动态创建/更新 iframe
  const container = document.getElementById('player-container');
  

  // 创建一个时间格式化器，用来把毫秒时间戳格式化成 HH:MM:SS 这样的可读时间。
  //
  // new Intl.DateTimeFormat(undefined, ...) 中：
  // - undefined 表示使用用户浏览器默认地区/语言环境
  // - hour/minute/second 都要求用 2 位数字显示
  //
  // 比如会把某个 Date 格式化成类似：
  // 14:03:09
  const clockFormatter = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });


  // =========================
  // 一些同步相关的常量配置
  // =========================

  // 心跳发送间隔：每 5000ms（5 秒）给服务器发一次 heartbeat。
  // 心跳的目的有两个：
  // 1. 告诉服务器“我还活着”
  // 2. 通过请求-响应时间，估算客户端与服务器的时间偏移
  const HEARTBEAT_INTERVAL_MS = 5000;

  // 最多保留多少个“时间偏移采样”
  // 每次心跳完成后，都会得到一个 offset sample（时间偏移样本）
  // 样本太多没必要，保留最近/最优的一部分即可
  const OFFSET_SAMPLE_LIMIT = 8;

  // 偏移采样的最大存活时间（30 秒）
  // 超过这个时间的采样会被丢弃，避免使用陈旧网络状态推算当前时间
  const OFFSET_MAX_AGE_MS = 30000;

  // 如果客户端发现“当前拿到的服务器快照已经明显过时了”，
  // 且过时程度超过 2000ms，就会考虑主动请求 resync
  const RESYNC_THRESHOLD_MS = 2000;

  // resync 冷却时间：两次 resync 之间至少间隔 3000ms
  // 防止网络抖动时疯狂向服务器请求重同步
  const RESYNC_COOLDOWN_MS = 3000;


  // =========================
  // 服务器状态快照（客户端本地缓存）
  // =========================
  //
  // 这份对象表示：服务器上“最近一次已知的权威播放状态”。
  // 注意：这不是“当前时刻”的状态，而是“某个服务器时间点上的状态”。
  //
  // 例如：
  // - position_ms = 10000
  // - state_at_ms = 服务器时间 12:00:00.000
  // - status = 'playing'
  //
  // 这表示：在服务器 12:00:00.000 那一刻，视频播到了 10 秒，并且处于播放中。
  // 那如果现在服务器时间是 12:00:05.000，
  // 客户端就可以推算：当前应该播到 15 秒。
  let serverSnapshot = {
    actor: null,        // 最近一次触发控制行为的人（谁点了播放/暂停/seek）
    position_ms: 0,     // 在 state_at_ms 那一刻，视频所在位置（毫秒）
    state_at_ms: null,  // 服务器记录这份状态时的服务器时间戳（毫秒）
    status: 'paused',   // 服务器报告的状态：'playing' 或 'paused'
    url: null,          // 当前正在共享的视频地址
  };

  // 当前 socket 连接状态，仅用于页面显示与逻辑判断
  // 可能值：
  // - 'connected'
  // - 'disconnected'
  let connectionStatus = 'disconnected';

  // 最近的一批“客户端时钟 vs 服务器时钟”的偏移样本。
  //
  // 样本结构大概长这样：
  // {
  //   offset_ms: 本地 performance.now 坐标系 相对于 服务器时间 的偏移,
  //   rtt_ms:    这次心跳往返耗时（round-trip time）,
  //   received_perf_ms: 本地收到 ack 时的 performance.now()
  // }
  //
  // 这些样本用于建立一个映射：
  // “当前本地 performance.now() 对应服务器时间是多少”
  let offsetSamples = [];

  // 上一次请求 resync 的本地性能时间戳
  // 用于 resync 的节流/冷却控制
  let lastResyncRequestAt = null;


  // 一个简写函数：
  // performance.now() 返回一个高精度单调递增时间，适合做时间差计算。
  // 它不像 Date.now() 会受系统时钟调整影响。
  const nowMs = () => performance.now();


  // =========================
  // UI 工具函数
  // =========================

  function setStatus(text) {
    // 更新页面上的状态提示文本
    // 比如显示：
    // "connected: playing | t=13s | video loaded ..."
    if (statusEl) statusEl.textContent = text;
  }

  function setControlsEnabled(enabled) {
    // 统一控制播放按钮 / 暂停按钮 / seek 按钮是否可点击。
    // 一般在没有加载视频时，这些按钮应禁用，避免发送无意义控制命令。
    [playBtn, pauseBtn, seekBtn].forEach((btn) => {
      if (btn) btn.disabled = !enabled;
    });
  }

  function resetPlaybackForNewVideo(url) {
    // 当用户通过 HTTP 接口加载了一个“新视频”时，
    // 本地缓存的 serverSnapshot 应该重置。
    //
    // 为什么要重置？
    // 因为旧视频的 position/status/state_at_ms 已经不适用于新视频了。
    serverSnapshot = {
      actor: null,
      position_ms: 0,
      state_at_ms: null,
      status: 'paused',
      url: url || null,
    };

    // 有 URL 才允许使用播放控制
    setControlsEnabled(Boolean(url));
  }


  // =========================
  // 偏移样本维护
  // =========================

  function pruneOffsetSamples(nowPerf) {
    // 清理过旧的 offset sample。
    // 样本太老的话，网络状态可能已经变化，继续用它推算会越来越不准。
    offsetSamples = offsetSamples.filter((sample) => {
      return nowPerf - sample.received_perf_ms <= OFFSET_MAX_AGE_MS;
    });

    // 如果样本数量超了上限，只保留最后 OFFSET_SAMPLE_LIMIT 个
    if (offsetSamples.length > OFFSET_SAMPLE_LIMIT) {
      offsetSamples = offsetSamples.slice(-OFFSET_SAMPLE_LIMIT);
    }
  }

  function currentOffsetSample(nowPerf = nowMs()) {
    // 取“当前最适合使用”的 offset sample。
    // 这里不是简单取最新样本，而是取 RTT 最小的那个。
    //
    // 为什么？
    // 因为 RTT 越小，说明这次心跳途中排队/网络抖动越少，
    // 这个样本对“中点时间”估算通常更干净、更接近真实值。
    pruneOffsetSamples(nowPerf);

    if (offsetSamples.length === 0) return null;

    return offsetSamples.reduce((best, sample) => {
      return sample.rtt_ms < best.rtt_ms ? sample : best;
    });
  }

  function currentServerTimeMs(offsetSample = currentOffsetSample()) {
    // 把“当前本地 performance.now()”映射到“当前服务器时间”。
    //
    // 我们记录的 offset_ms 定义是：
    // offset_ms = 本地 perf 时间 - 服务器时间
    //
    // 所以：
    // 服务器时间 = 本地 perf 时间 - offset_ms
    //
    // 如果还没有任何 offset sample，就没法估计服务器时间，返回 null。
    if (!offsetSample) {
      return null;
    }
    return nowMs() - offsetSample.offset_ms;
  }


  // =========================
  // 根据服务器快照推算“当前播放位置”
  // =========================

  function positionAtServerTime(snapshot, serverTimeMs) {
    // 给定一份 snapshot，以及一个“目标服务器时间”，
    // 计算在那个服务器时间点，视频应该播到哪里。
    //
    // 逻辑：
    // 1. 先拿 snapshot.position_ms 作为基础位置
    // 2. 如果 snapshot.status 不是 'playing'，说明处于暂停状态
    //    那么当前位置就仍然是 base，不会往前推进
    // 3. 如果是 playing，则当前位置 = base + (serverTimeMs - state_at_ms)
    //
    // 这里全部以毫秒为单位。
    const base = Math.max(0, Number(snapshot.position_ms) || 0);
    const stateAtMs = Number(snapshot.state_at_ms);

    // 以下情况直接返回 base：
    // - 当前状态不是 playing
    // - state_at_ms 不是合法数字
    // - serverTimeMs 不是合法数字
    if (
      snapshot.status !== 'playing' ||
      !Number.isFinite(stateAtMs) ||
      !Number.isFinite(serverTimeMs)
    ) {
      return base;
    }

    // 如果正在播放，则用经过的服务器时间把位置向前推进。
    // Math.max(0, serverTimeMs - stateAtMs) 是为了避免出现负增量。
    return Math.max(0, base + Math.max(0, serverTimeMs - stateAtMs));
  }

  function currentDisplayedPositionMs() {
    // 计算“此时此刻页面应该显示的视频位置”。
    //
    // 如果没有视频 URL，说明根本没视频，直接返回 0。
    if (!serverSnapshot.url) {
      return 0;
    }

    // 先估算“现在的服务器时间”
    const serverTimeMs = currentServerTimeMs();

    // 如果还没有建立时钟映射（serverTimeMs 不可用），
    // 那就只能退化成使用 snapshot 里存的 position_ms。
    if (!Number.isFinite(serverTimeMs)) {
      return Math.max(0, Number(serverSnapshot.position_ms) || 0);
    }

    // 如果可以估算当前服务器时间，则把 snapshot 投影到“当前服务器时刻”
    return positionAtServerTime(serverSnapshot, serverTimeMs);
  }

  function snapshotAgeMs() {
    // 计算：当前快照距离“现在的服务器时间”已经过去了多久。
    //
    // 例如：
    // - 当前服务器时间估算为 1,000,000 ms
    // - 快照里的 state_at_ms 为   998,000 ms
    // 那么 age = 2000 ms
    //
    // 这个值大，说明我们的快照比较旧了。
    const serverTimeMs = currentServerTimeMs();
    const stateAtMs = Number(serverSnapshot.state_at_ms);

    if (!Number.isFinite(serverTimeMs) || !Number.isFinite(stateAtMs)) {
      return 0;
    }

    return Math.max(0, serverTimeMs - stateAtMs);
  }


  // =========================
  // resync 节流逻辑
  // =========================

  function shouldThrottleResync(nowPerf = nowMs()) {
    // 如果距离上一次 resync 请求还没超过冷却时间，
    // 那就不允许再次请求。
    return (
      lastResyncRequestAt !== null &&
      (nowPerf - lastResyncRequestAt) < RESYNC_COOLDOWN_MS
    );
  }

  function requestResync() {
    // 请求服务器发送一份新的权威状态快照。
    //
    // 何时需要？
    // 比如：
    // - 我们刚建立时钟映射，发现手里旧快照已经太老
    // - 网络抖动导致当前显示位置可能明显偏了
    //
    // 如果当前仍处于 resync 冷却期，或者 socket 未连接，
    // 就不要发请求。
    const nowPerf = nowMs();
    if (shouldThrottleResync(nowPerf) || !socket.connected) {
      return;
    }

    // 记录这次请求时间，进入冷却
    lastResyncRequestAt = nowPerf;

    // 发给服务器一个 sync:resync 事件，请它下发 fresh snapshot
    socket.emit('sync:resync');
  }

  function maybeRequestResync(reason) {
    // 在某些场景下“视情况决定”要不要请求 resync。
    //
    // 这里的逻辑是：
    // 只有在以下条件下，才可能 resync：
    // 1. 当前确实已经有视频
    // 2. 当前视频处于 playing 状态
    // 3. 当前已经至少拿到一个 offset sample（即能估算服务器时间）
    if (!serverSnapshot.url || serverSnapshot.status !== 'playing' || !currentOffsetSample()) {
      return;
    }

    // 当 reason === 'offset_established' 时，表示：
    // “刚刚第一次建立起客户端<->服务器时钟映射”
    //
    // 这时如果发现当前快照已经老到超过阈值，
    // 就请求一份新的，避免一上来显示就不准。
    if (reason === 'offset_established' && snapshotAgeMs() > RESYNC_THRESHOLD_MS) {
      requestResync();
    }
  }


  // =========================
  // 播放器渲染逻辑
  // =========================

  function renderPlayer(url, isPlaying, positionMs) {
    // 根据目标 url / 是否自动播放 / 目标时间点，更新 iframe 播放器。
    //
    // 注意：这里不是精细控制 HTML5 <video> 的 currentTime，
    // 而是通过构造 URL 参数（例如 autoplay=1, t=10）去控制嵌入播放器。
    //
    // 这通常适合某些外部视频平台的 embed 页面。
    if (!container) return;

    // 以传入 url 为基础构造一个 URL 对象，便于改 query 参数
    const target = new URL(url);

    // autoplay=1 表示自动播放，autoplay=0 表示不自动播放
    target.searchParams.set('autoplay', isPlaying ? '1' : '0');

    // 将毫秒位置转成秒
    const seconds = Math.floor(Math.max(0, positionMs || 0) / 1000);

    // 如果目标时间点 > 0，则加上 t=秒数
    // 否则删除 t 参数，表示从头开始/不指定时间
    if (seconds > 0) {
      target.searchParams.set('t', String(seconds));
    } else {
      target.searchParams.delete('t');
    }

    // 找容器里是否已有 iframe
    let iframe = container.querySelector('iframe');

    // 如果没有，就新创建一个
    if (!iframe) {
      iframe = document.createElement('iframe');

      // 允许自动播放和全屏
      iframe.setAttribute('allow', 'autoplay; fullscreen');

      // 老式写法：去掉边框
      iframe.setAttribute('frameborder', '0');

      // 简单设置一下大小
      iframe.style.width = '100%';
      iframe.style.height = '480px';

      // 放进容器
      container.appendChild(iframe);
    }

    // 更新 iframe 的 src
    // 这一步通常会让嵌入播放器跳到指定地址/时间/自动播放状态
    iframe.src = target.toString();
  }

  function renderFromSnapshot() {
    // 用“当前缓存的 serverSnapshot + 当前估算的服务器时间”
    // 渲染播放器。
    //
    // 也就是：
    // 1. 先计算现在应该播到哪
    // 2. 再按这个位置和状态更新 iframe
    if (!serverSnapshot.url) {
      return;
    }

    renderPlayer(
      serverSnapshot.url,
      serverSnapshot.status === 'playing',
      currentDisplayedPositionMs()
    );
  }


  // =========================
  // 服务器状态快照应用逻辑
  // =========================

  function applyServerSnapshot(state) {
    // 用服务器下发的新状态，替换本地缓存的 serverSnapshot。
    //
    // 这里很重要的一点是：
    // “直接缓存服务器给的权威状态”，
    // 而不是把它先按本地时间推进后再缓存。
    //
    // 为什么？
    // 因为 serverSnapshot 应该始终表示：
    // “服务器在 state_at_ms 那一刻的状态”
    //
    // 这样后续才能基于 offset 去做一致的时间投影。
    serverSnapshot = {
      actor: state.actor ?? null,
      position_ms: Math.max(0, Number(state.position_ms) || 0),
      state_at_ms: Number.isFinite(Number(state.state_at_ms)) ? Number(state.state_at_ms) : null,
      status: state.status || 'paused',
      url: state.url || null,
    };

    // 根据是否有 url 决定能否操作控制按钮
    setControlsEnabled(Boolean(serverSnapshot.url));

    // 重新渲染播放器
    renderFromSnapshot();

    // 更新状态栏文本
    refreshStatus();

    // 既然拿到了 fresh snapshot，就清空 resync 冷却标记
    // 表示这次 resync 已完成
    lastResyncRequestAt = null;
  }


  // =========================
  // 记录 offset sample
  // =========================

  function recordOffsetSample(clientPerfSentMs, ack) {
    // 根据一次 heartbeat 往返，生成一个偏移样本。
    //
    // 一般流程是：
    // 1. 客户端在本地 perf 时间 sentMs 发出 heartbeat
    // 2. 服务器收到后返回 ack，其中带上 server_now_ms
    // 3. 客户端在本地 perf 时间 recvMs 收到 ack
    //
    // 于是：
    // RTT = recvMs - sentMs
    // 取中点 midpoint = (sentMs + recvMs) / 2
    //
    // 假设网络往返大致对称，
    // 那么 midpoint 对应的“服务器时间”大约就是 ack.server_now_ms
    //
    // 因而可得：
    // offset_ms = midpointPerfMs - ack.server_now_ms
    //
    // 以后就可以用：
    // serverTime = nowPerf - offset_ms
    if (!ack || typeof ack.server_now_ms !== 'number' || typeof clientPerfSentMs !== 'number') {
      return;
    }

    // 记录下：在添加这次样本前，是否已经存在可用 offset
    const hadOffset = Boolean(currentOffsetSample());

    // 本地收到 ack 的 perf 时间
    const clientPerfRecvMs = nowMs();

    // 往返时间 RTT
    const rttMs = clientPerfRecvMs - clientPerfSentMs;

    // RTT 非法时丢弃
    if (!Number.isFinite(rttMs) || rttMs < 0) {
      return;
    }

    // 取请求-响应的中点 perf 时间
    const midpointPerfMs = (clientPerfSentMs + clientPerfRecvMs) / 2;

    // 记录样本
    offsetSamples.push({
      offset_ms: midpointPerfMs - ack.server_now_ms,
      rtt_ms: rttMs,
      received_perf_ms: clientPerfRecvMs,
    });

    // 清理旧样本
    pruneOffsetSamples(clientPerfRecvMs);

    // 如果之前没有 offset，现在第一次建立起映射：
    if (!hadOffset && currentOffsetSample(clientPerfRecvMs)) {
      // 重新渲染播放器，因为现在终于可以把 serverSnapshot 投影到“当前服务器时间”了
      renderFromSnapshot();

      // 更新状态显示
      refreshStatus();

      // 如果手里的快照过旧，考虑主动请求 resync
      maybeRequestResync('offset_established');
    }
  }


  // =========================
  // 状态文本生成
  // =========================

  function describePlayback() {
    // 生成一条给人看的调试信息，帮助观察同步状态。
    //
    // 比如可能显示：
    // connected: playing | t=13s | video loaded | snapshot_at=15:21:09 | offset=23ms rtt=40ms

    // 当前推算出来的视频位置（秒）
    const positionSeconds = Math.round(currentDisplayedPositionMs() / 1000);

    // 当前选中的最佳 offset sample
    const offsetSample = currentOffsetSample();

    // 如果有 offset，就把 offset 和 RTT 也显示出来
    const offsetLabel = offsetSample
      ? ` | offset=${Math.round(offsetSample.offset_ms)}ms rtt=${Math.round(offsetSample.rtt_ms)}ms`
      : '';

    // snapshot 的记录时间格式化显示
    const snapshotClock = Number.isFinite(Number(serverSnapshot.state_at_ms))
      ? clockFormatter.format(new Date(Number(serverSnapshot.state_at_ms)))
      : '--:--:--';

    // 简单显示是否有视频
    const videoLabel = serverSnapshot.url ? 'video loaded' : 'no video';

    return `${connectionStatus}: ${serverSnapshot.status} | t=${positionSeconds}s | ${videoLabel} | snapshot_at=${snapshotClock}${offsetLabel}`;
  }

  function refreshStatus() {
    // 根据当前连接状态和播放状态，刷新页面状态文字。
    if (connectionStatus !== 'connected') {
      setStatus('Disconnected - attempting reconnect');
      return;
    }

    setStatus(describePlayback());
  }


  // =========================
  // 心跳逻辑
  // =========================

  function sendHeartbeat() {
    // 向服务器发送 heartbeat：
    // - 报告客户端当前感知的播放状态
    // - 记录发送时的 perf 时间
    // - 等待服务器回 ack，用于生成 offset sample
    if (!socket.connected) return;

    const heartbeat = {
      // 当前视频 URL
      url: serverSnapshot.url,

      // 当前状态 playing / paused
      status: serverSnapshot.status,

      // 当前推算的播放位置（毫秒）
      position_ms: Math.round(currentDisplayedPositionMs()),

      // 本地发送时刻，用 performance.now 记录
      client_perf_sent_ms: nowMs(),
    };

    // 发送 heartbeat，并注册 ack 回调
    socket.emit('heartbeat', heartbeat, (ack) => {
      recordOffsetSample(heartbeat.client_perf_sent_ms, ack);
    });
  }


  // =========================
  // 用户控制行为上报
  // =========================

  function emitControl(type, position_ms) {
    // 当本地用户点击播放/暂停/seek 时，
    // 不直接本地改状态，而是把“控制意图”发给服务器。
    //
    // 这样服务器可以作为权威来源，统一广播给房间内所有人。
    if (!serverSnapshot.url) {
      setStatus('Load a video before using playback controls');
      return;
    }

    // 如果没显式传 position_ms，就默认使用当前推算出来的位置
    const positionMs = position_ms ?? Math.round(currentDisplayedPositionMs());

    socket.emit('control', {
      type,         // 'play' | 'pause' | 'seek'
      position_ms: positionMs,
    });
  }


  // 初始时禁用所有控制按钮，因为页面刚加载时还没有视频
  setControlsEnabled(false);


  // =========================
  // Socket.IO 事件监听
  // =========================

  socket.on('connect', () => {
    // Socket 成功连接服务器
    connectionStatus = 'connected';

    // 更新状态栏
    refreshStatus();

    // 一连接上就立刻发一次 heartbeat，
    // 这样能尽快建立 offset sample
    sendHeartbeat();
  });

  socket.on('disconnect', () => {
    // 连接断开
    connectionStatus = 'disconnected';

    // 提示用户正在尝试重连
    setStatus('Disconnected - attempting reconnect');

    // 连接断开时禁用控制按钮
    setControlsEnabled(false);
  });

  socket.on('state', (state) => {
    // 服务器下发新的权威状态快照
    // 直接应用
    applyServerSnapshot(state);
  });


  // =========================
  // 自定义 DOM 事件：video:loaded
  // =========================
  //
  // 这个事件不是 Socket.IO 事件，而是页面内部自定义事件。
  // 看起来这套系统里，当别处通过 HTTP 接口加载新视频后，
  // 页面会 dispatch 一个 video:loaded 事件，把新 URL 放在 event.detail.url 里。
  document.addEventListener('video:loaded', (event) => {
    const url = event.detail && event.detail.url;
    if (!url) return;

    // 本地先重置为“新视频、初始暂停、位置 0”
    resetPlaybackForNewVideo(url);

    // 更新状态显示
    refreshStatus();
  });


  // =========================
  // 按钮事件绑定
  // =========================

  // 点播放 -> 通知服务器：我要 play
  if (playBtn) playBtn.addEventListener('click', () => emitControl('play'));

  // 点暂停 -> 通知服务器：我要 pause
  if (pauseBtn) pauseBtn.addEventListener('click', () => emitControl('pause'));

  // 点 seek -> 通知服务器：我要跳到 10000ms（即 10 秒）
  // 这里只是示例写法，真实项目里通常会从输入框/拖动条读取目标时间
  if (seekBtn) seekBtn.addEventListener('click', () => emitControl('seek', 10000));


  // =========================
  // 定时任务
  // =========================

  // 每秒刷新一次状态显示文字
  // 这样即使没有收到新状态，t=xxs 这种显示也会不断更新
  setInterval(refreshStatus, 1000);

  // 每 HEARTBEAT_INTERVAL_MS 发送一次心跳
  // 用于保持时钟映射新鲜
  setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);

  // 页面初始化完成后，先刷新一次状态文字
  refreshStatus();
});