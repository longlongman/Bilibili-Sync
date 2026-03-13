document.addEventListener('DOMContentLoaded', () => {
  if (!window.io) {
    return;
  }
  const socket = window.appSocket || io({ withCredentials: true });
  window.appSocket = socket;
  const statusEl = document.getElementById('video-message');
  const playBtn = document.getElementById('play-btn');
  const pauseBtn = document.getElementById('pause-btn');
  const seekBtn = document.getElementById('seek-btn');
  const container = document.getElementById('player-container');
  const clockFormatter = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const HEARTBEAT_INTERVAL_MS = 5000;
  let lastState = { status: 'paused', position_ms: 0, url: null };
  let lastStateAt = performance.now();
  let connectionStatus = 'disconnected';

  const nowMs = () => performance.now();

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function setControlsEnabled(enabled) {
    [playBtn, pauseBtn, seekBtn].forEach((btn) => {
      if (btn) btn.disabled = !enabled;
    });
  }

  setControlsEnabled(false);

  function resetPlaybackForNewVideo(url) {
    lastState = { status: 'paused', position_ms: 0, url: url || null };
    lastStateAt = nowMs();
    setControlsEnabled(Boolean(url));
  }

  function currentPositionMs() {
    const base = lastState.position_ms || 0;
    if (lastState.status === 'playing') {
      return Math.max(0, base + (nowMs() - lastStateAt));
    }
    return Math.max(0, base);
  }

  function renderPlayer(url, isPlaying, positionMs) {
    if (!container) return;
    const target = new URL(url);
    target.searchParams.set('autoplay', isPlaying ? '1' : '0');
    const seconds = Math.floor(Math.max(0, positionMs || 0) / 1000);
    if (seconds > 0) {
      target.searchParams.set('t', String(seconds));
    } else {
      target.searchParams.delete('t');
    }
    let iframe = container.querySelector('iframe');
    if (!iframe) {
      iframe = document.createElement('iframe');
      iframe.setAttribute('allow', 'autoplay; fullscreen');
      iframe.setAttribute('frameborder', '0');
      iframe.style.width = '100%';
      iframe.style.height = '480px';
      container.appendChild(iframe);
    }
    const nextSrc = target.toString();
    // Always reset src so repeated seek commands take effect.
    iframe.src = nextSrc;
  }

  function describePlayback() {
    const positionSeconds = Math.round(currentPositionMs() / 1000);
    const stateLabel = lastState.status || 'unknown';
    const stateAt = lastStateAt || nowMs();
    const stateAtClock = clockFormatter.format(new Date(Date.now() - (nowMs() - stateAt)));
    const clock = clockFormatter.format(new Date());
    const videoLabel = lastState.url ? 'video loaded' : 'no video';
    return `${connectionStatus}: ${stateLabel} | t=${positionSeconds}s | ${videoLabel} | state_at=${stateAtClock} | ${clock}`;
  }

  function refreshStatus() {
    if (connectionStatus !== 'connected') {
      setStatus('Disconnected - attempting reconnect');
      return;
    }
    setStatus(describePlayback());
  }

  function sendHeartbeat() {
    if (!socket.connected) return;
    const heartbeat = {
      url: lastState.url,
      status: lastState.status,
      position_ms: Math.round(currentPositionMs()),
      reported_at: new Date().toISOString(),
    };
    socket.emit('heartbeat', heartbeat);
  }

  socket.on('connect', () => {
    connectionStatus = 'connected';
    refreshStatus();
    sendHeartbeat();
  });
  socket.on('disconnect', () => {
    connectionStatus = 'disconnected';
    setStatus('Disconnected - attempting reconnect');
    setControlsEnabled(false);
  });

  socket.on('state', (state) => {
    const prevUrl = lastState.url;
    const urlChanged = state.url && prevUrl && state.url !== prevUrl;
    const firstUrlSet = state.url && !prevUrl;
    if (urlChanged || firstUrlSet) {
      setControlsEnabled(true);
    } else if (!state.url) {
      setControlsEnabled(false);
    }
    lastState = state;
    lastStateAt = nowMs();
    const positionMs = state.position_ms || 0;
    refreshStatus();
    if (state.url) {
      renderPlayer(state.url, state.status === 'playing', positionMs);
    }
  });

  function emitControl(type, position_ms) {
    if (!lastState.url) {
      setStatus('Load a video before using playback controls');
      return;
    }
    const positionMs = position_ms ?? Math.round(currentPositionMs());
    socket.emit('control', {
      type,
      position_ms: positionMs,
      reported_at: new Date().toISOString(),
    });
  }

  // Reset local timer when a new video is loaded via HTTP endpoint.
  document.addEventListener('video:loaded', (event) => {
    const url = event.detail && event.detail.url;
    if (!url) return;
    resetPlaybackForNewVideo(url);
    refreshStatus();
  });

  if (playBtn) playBtn.addEventListener('click', () => emitControl('play'));
  if (pauseBtn) pauseBtn.addEventListener('click', () => emitControl('pause'));
  if (seekBtn) seekBtn.addEventListener('click', () => emitControl('seek', 10000));

  // Periodically show the local playback status (play/pause, seconds, current clock).
  setInterval(refreshStatus, 1000);
  setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
  refreshStatus();
});
