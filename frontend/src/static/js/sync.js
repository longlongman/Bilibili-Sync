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

  let serverSnapshot = {
    actor: null,
    position_ms: 0,
    state_at_ms: null,
    status: 'paused',
    url: null,
  };
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

  function resetPlaybackForNewVideo(url) {
    // Reset the cached server snapshot whenever a different shared video is selected.
    serverSnapshot = {
      actor: null,
      position_ms: 0,
      state_at_ms: null,
      status: 'paused',
      url: url || null,
    };
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

  function currentServerTimeMs(offsetSample = currentOffsetSample()) {
    // Map the local perf clock back into the server time axis.
    if (!offsetSample) {
      return null;
    }
    return nowMs() - offsetSample.offset_ms;
  }

  function positionAtServerTime(snapshot, serverTimeMs) {
    // Project a server snapshot forward to a specific server timestamp.
    const base = Math.max(0, Number(snapshot.position_ms) || 0);
    const stateAtMs = Number(snapshot.state_at_ms);
    if (snapshot.status !== 'playing' || !Number.isFinite(stateAtMs) || !Number.isFinite(serverTimeMs)) {
      return base;
    }
    return Math.max(0, base + Math.max(0, serverTimeMs - stateAtMs));
  }

  function currentDisplayedPositionMs() {
    // Derive the displayed playback position from the current server snapshot.
    if (!serverSnapshot.url) {
      return 0;
    }
    const serverTimeMs = currentServerTimeMs();
    if (!Number.isFinite(serverTimeMs)) {
      return Math.max(0, Number(serverSnapshot.position_ms) || 0);
    }
    return positionAtServerTime(serverSnapshot, serverTimeMs);
  }

  function snapshotAgeMs() {
    // Measure how far the latest authoritative snapshot trails the current server time.
    const serverTimeMs = currentServerTimeMs();
    const stateAtMs = Number(serverSnapshot.state_at_ms);
    if (!Number.isFinite(serverTimeMs) || !Number.isFinite(stateAtMs)) {
      return 0;
    }
    return Math.max(0, serverTimeMs - stateAtMs);
  }

  function shouldThrottleResync(nowPerf = nowMs()) {
    // Avoid flooding the server with repeated resync requests while unstable.
    return lastResyncRequestAt !== null && (nowPerf - lastResyncRequestAt) < RESYNC_COOLDOWN_MS;
  }

  function requestResync() {
    // Ask the server for a fresh authoritative snapshot when the cached one is too stale.
    const nowPerf = nowMs();
    if (shouldThrottleResync(nowPerf) || !socket.connected) {
      return;
    }
    lastResyncRequestAt = nowPerf;
    socket.emit('sync:resync');
  }

  function maybeRequestResync(reason) {
    // When the local clock mapping appears after a stale snapshot, request a fresh one.
    if (!serverSnapshot.url || serverSnapshot.status !== 'playing' || !currentOffsetSample()) {
      return;
    }
    if (reason === 'offset_established' && snapshotAgeMs() > RESYNC_THRESHOLD_MS) {
      requestResync();
    }
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
    iframe.src = target.toString();
  }

  function renderFromSnapshot() {
    // Render the current server snapshot at the current mapped server time.
    if (!serverSnapshot.url) {
      return;
    }
    renderPlayer(
      serverSnapshot.url,
      serverSnapshot.status === 'playing',
      currentDisplayedPositionMs()
    );
  }

  function applyServerSnapshot(state) {
    // Replace the cached server snapshot without writing back a locally advanced position.
    serverSnapshot = {
      actor: state.actor ?? null,
      position_ms: Math.max(0, Number(state.position_ms) || 0),
      state_at_ms: Number.isFinite(Number(state.state_at_ms)) ? Number(state.state_at_ms) : null,
      status: state.status || 'paused',
      url: state.url || null,
    };
    setControlsEnabled(Boolean(serverSnapshot.url));
    renderFromSnapshot();
    refreshStatus();
    lastResyncRequestAt = null;
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
      renderFromSnapshot();
      refreshStatus();
      maybeRequestResync('offset_established');
    }
  }

  function describePlayback() {
    // Render a human-readable status line for debugging the sync state.
    const positionSeconds = Math.round(currentDisplayedPositionMs() / 1000);
    const offsetSample = currentOffsetSample();
    const offsetLabel = offsetSample ? ` | offset=${Math.round(offsetSample.offset_ms)}ms rtt=${Math.round(offsetSample.rtt_ms)}ms` : '';
    const snapshotClock = Number.isFinite(Number(serverSnapshot.state_at_ms))
      ? clockFormatter.format(new Date(Number(serverSnapshot.state_at_ms)))
      : '--:--:--';
    const videoLabel = serverSnapshot.url ? 'video loaded' : 'no video';
    return `${connectionStatus}: ${serverSnapshot.status} | t=${positionSeconds}s | ${videoLabel} | snapshot_at=${snapshotClock}${offsetLabel}`;
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
    // Sample the current server-time-derived position and collect one offset measurement.
    if (!socket.connected) return;
    const heartbeat = {
      url: serverSnapshot.url,
      status: serverSnapshot.status,
      position_ms: Math.round(currentDisplayedPositionMs()),
      client_perf_sent_ms: nowMs(),
    };
    socket.emit('heartbeat', heartbeat, (ack) => {
      recordOffsetSample(heartbeat.client_perf_sent_ms, ack);
    });
  }

  function emitControl(type, position_ms) {
    // Send a local play, pause, or seek intent to the shared room.
    if (!serverSnapshot.url) {
      setStatus('Load a video before using playback controls');
      return;
    }
    const positionMs = position_ms ?? Math.round(currentDisplayedPositionMs());
    socket.emit('control', {
      type,
      position_ms: positionMs,
    });
  }

  setControlsEnabled(false);

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
    applyServerSnapshot(state);
  });

  // Reset local snapshot state when a new video is loaded via the HTTP endpoint.
  document.addEventListener('video:loaded', (event) => {
    const url = event.detail && event.detail.url;
    if (!url) return;
    resetPlaybackForNewVideo(url);
    refreshStatus();
  });

  if (playBtn) playBtn.addEventListener('click', () => emitControl('play'));
  if (pauseBtn) pauseBtn.addEventListener('click', () => emitControl('pause'));
  if (seekBtn) seekBtn.addEventListener('click', () => emitControl('seek', 10000));

  // Periodically show the local playback status and refresh the server clock mapping.
  setInterval(refreshStatus, 1000);
  setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
  refreshStatus();
});
