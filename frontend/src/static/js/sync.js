// Keep the local player aligned with the shared room state from Socket.IO.
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
  const OFFSET_SAMPLE_LIMIT = 8;
  const OFFSET_MAX_AGE_MS = 30000;
  const RESYNC_THRESHOLD_MS = 2000;
  const RESYNC_COOLDOWN_MS = 3000;
  let lastState = {
    status: 'paused',
    position_ms: 0,
    server_position_ms: 0,
    url: null,
    state_at_ms: null,
  };
  let lastStateAt = performance.now();
  let connectionStatus = 'disconnected';
  let offsetSamples = [];
  let lastResyncRequestAt = null;

  const nowMs = () => performance.now();

  function setStatus(text) {
    // Show the current playback or connection status near the player.
    if (statusEl) statusEl.textContent = text;
  }

  function setControlsEnabled(enabled) {
    // Prevent local playback controls from firing before a video is available.
    [playBtn, pauseBtn, seekBtn].forEach((btn) => {
      if (btn) btn.disabled = !enabled;
    });
  }

  setControlsEnabled(false);

  function resetPlaybackForNewVideo(url) {
    // Reset local timing whenever a different shared video is selected.
    lastState = {
      status: 'paused',
      position_ms: 0,
      server_position_ms: 0,
      url: url || null,
      state_at_ms: null,
    };
    lastStateAt = nowMs();
    setControlsEnabled(Boolean(url));
  }

  function pruneOffsetSamples(nowPerf) {
    // Keep only recent offset samples so reconnects and clock drift can recover.
    offsetSamples = offsetSamples.filter((sample) => nowPerf - sample.received_perf_ms <= OFFSET_MAX_AGE_MS);
    if (offsetSamples.length > OFFSET_SAMPLE_LIMIT) {
      offsetSamples = offsetSamples.slice(-OFFSET_SAMPLE_LIMIT);
    }
  }

  function currentOffsetSample(nowPerf = nowMs()) {
    pruneOffsetSamples(nowPerf);
    if (offsetSamples.length === 0) return null;
    // The lowest-RTT sample is usually the cleanest mapping from server time
    // into the local perf clock because it includes the least queueing delay.
    return offsetSamples.reduce((best, sample) => (sample.rtt_ms < best.rtt_ms ? sample : best));
  }

  function shouldThrottleResync(nowPerf = nowMs()) {
    // Avoid flooding the server with repeated resync requests while unstable.
    return lastResyncRequestAt !== null && (nowPerf - lastResyncRequestAt) < RESYNC_COOLDOWN_MS;
  }

  function requestResync() {
    // Ask the server for a fresh authoritative snapshot when drift is too large.
    const nowPerf = nowMs();
    if (shouldThrottleResync(nowPerf) || !socket.connected) {
      return;
    }
    lastResyncRequestAt = nowPerf;
    socket.emit('sync:resync');
  }

  function derivePositionFromServerState(state, offsetSample = currentOffsetSample()) {
    // Map a server snapshot onto the local perf clock and advance it to now.
    const serverPositionMs = Math.max(0, Number(state.server_position_ms ?? state.position_ms) || 0);
    const stateAtMs = Number(state.state_at_ms);
    if (state.status !== 'playing' || !Number.isFinite(stateAtMs) || !offsetSample) {
      return serverPositionMs;
    }
    const mappedStatePerfMs = stateAtMs + offsetSample.offset_ms;
    const elapsedMs = Math.max(0, nowMs() - mappedStatePerfMs);
    return Math.max(0, serverPositionMs + elapsedMs);
  }

  function applyState(state, { rerender = true } = {}) {
    // Store the latest authoritative state and optionally refresh the iframe.
    const serverPositionMs = Math.max(0, Number(state.position_ms) || 0);
    const derivedPositionMs = derivePositionFromServerState(
      {
        ...state,
        server_position_ms: serverPositionMs,
      },
      currentOffsetSample()
    );
    lastState = {
      ...state,
      position_ms: derivedPositionMs,
      server_position_ms: serverPositionMs,
      state_at_ms: Number.isFinite(Number(state.state_at_ms)) ? Number(state.state_at_ms) : null,
    };
    lastStateAt = nowMs();
    refreshStatus();
    if (rerender && state.url) {
      renderPlayer(state.url, state.status === 'playing', derivedPositionMs);
    }
  }

  function recalibrateCurrentState() {
    if (!lastState.url || lastState.status !== 'playing' || !Number.isFinite(Number(lastState.state_at_ms))) {
      return;
    }
    // The first offset often arrives after the initial state, so re-derive the
    // playback baseline from the last server snapshot once timing is available.
    applyState(
      {
        ...lastState,
        position_ms: lastState.server_position_ms,
      },
      { rerender: true }
    );
  }

  function maybeRequestResync() {
    // Compare local progress with the projected server position after each heartbeat.
    const offsetSample = currentOffsetSample();
    if (!offsetSample || !lastState.url || lastState.status !== 'playing') {
      return;
    }
    const expectedPositionMs = derivePositionFromServerState(lastState, offsetSample);
    const localPositionMs = currentPositionMs();
    if (Math.abs(localPositionMs - expectedPositionMs) > RESYNC_THRESHOLD_MS) {
      requestResync();
    }
  }

  function recordOffsetSample(clientPerfSentMs, ack) {
    // Convert a heartbeat round trip into one offset sample for server-time mapping.
    if (!ack || typeof ack.server_now_ms !== 'number' || typeof clientPerfSentMs !== 'number') {
      return;
    }
    const hadOffset = Boolean(currentOffsetSample());
    const clientPerfRecvMs = nowMs();
    const rttMs = clientPerfRecvMs - clientPerfSentMs;
    if (!Number.isFinite(rttMs) || rttMs < 0) {
      return;
    }
    const midpointPerfMs = (clientPerfSentMs + clientPerfRecvMs) / 2;
    offsetSamples.push({
      offset_ms: midpointPerfMs - ack.server_now_ms,
      rtt_ms: rttMs,
      received_perf_ms: clientPerfRecvMs,
    });
    pruneOffsetSamples(clientPerfRecvMs);
    if (!hadOffset && currentOffsetSample(clientPerfRecvMs)) {
      recalibrateCurrentState();
    }
    maybeRequestResync();
  }

  function currentPositionMs() {
    // Advance the locally cached baseline forward while playback is running.
    const base = lastState.position_ms || 0;
    if (lastState.status === 'playing') {
      return Math.max(0, base + (nowMs() - lastStateAt));
    }
    return Math.max(0, base);
  }

  function renderPlayer(url, isPlaying, positionMs) {
    // Rebuild the embed URL so autoplay and seek state match the shared snapshot.
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
    // Render a human-readable status line for debugging the sync state.
    const positionSeconds = Math.round(currentPositionMs() / 1000);
    const stateLabel = lastState.status || 'unknown';
    const stateAt = lastStateAt || nowMs();
    const stateAtClock = clockFormatter.format(new Date(Date.now() - (nowMs() - stateAt)));
    const clock = clockFormatter.format(new Date());
    const videoLabel = lastState.url ? 'video loaded' : 'no video';
    const offsetSample = currentOffsetSample(stateAt);
    const offsetLabel = offsetSample ? ` | offset=${Math.round(offsetSample.offset_ms)}ms rtt=${Math.round(offsetSample.rtt_ms)}ms` : '';
    return `${connectionStatus}: ${stateLabel} | t=${positionSeconds}s | ${videoLabel} | state_at=${stateAtClock} | ${clock}${offsetLabel}`;
  }

  function refreshStatus() {
    // Keep the status line consistent with the latest connection and playback state.
    if (connectionStatus !== 'connected') {
      setStatus('Disconnected - attempting reconnect');
      return;
    }
    setStatus(describePlayback());
  }

  function sendHeartbeat() {
    // Sample the local position and collect one offset measurement from the server.
    if (!socket.connected) return;
    const heartbeat = {
      url: lastState.url,
      status: lastState.status,
      position_ms: Math.round(currentPositionMs()),
      client_perf_sent_ms: nowMs(),
    };
    socket.emit('heartbeat', heartbeat, (ack) => {
      recordOffsetSample(heartbeat.client_perf_sent_ms, ack);
    });
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
    applyState(state);
    lastResyncRequestAt = null;
  });

  function emitControl(type, position_ms) {
    // Send a local play, pause, or seek intent to the shared room.
    if (!lastState.url) {
      setStatus('Load a video before using playback controls');
      return;
    }
    const positionMs = position_ms ?? Math.round(currentPositionMs());
    socket.emit('control', {
      type,
      position_ms: positionMs,
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
