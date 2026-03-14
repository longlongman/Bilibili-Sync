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
  const CLOCK_SMOOTHING = 0.2;
  const RTT_SMOOTHING = 0.3;
  const OFFSET_REAPPLY_THRESHOLD_MS = 100;

  let lastState = emptyState();
  let lastStateReceivedMonoMs = performance.now();
  let connectionStatus = 'disconnected';
  let clockOffsetMs = null;
  let estimatedRttMs = null;

  function emptyState() {
    // A `state` payload represents the room at a specific server timestamp.
    // `position_ms` is the base position at `server_state_at_ms`; clients turn
    // that into "current position" with `projectedPositionMs`.
    return {
      status: 'paused',
      position_ms: 0,
      url: null,
      actor: null,
      server_state_at_ms: null,
      server_sent_ms: 0,
      revision: 0,
    };
  }

  const nowMonoMs = () => performance.now();
  const roundMs = (value) => Math.round(value);

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function setControlsEnabled(enabled) {
    [playBtn, pauseBtn, seekBtn].forEach((btn) => {
      if (btn) btn.disabled = !enabled;
    });
  }

  setControlsEnabled(false);

  function smooth(previousValue, nextValue, factor) {
    if (previousValue === null || previousValue === undefined) {
      return nextValue;
    }
    return previousValue + ((nextValue - previousValue) * factor);
  }

  function estimatedServerNowMs(monoMs = nowMonoMs()) {
    if (clockOffsetMs === null) {
      return null;
    }
    return monoMs + clockOffsetMs;
  }

  function projectedPositionMs(state, monoMs = nowMonoMs(), fallbackReceivedMonoMs = lastStateReceivedMonoMs) {
    // Once the client has a clock offset, it projects every room snapshot onto
    // the server time axis. Before that, it falls back to a weaker estimate:
    // how much time had already elapsed when the server emitted this snapshot,
    // plus how much local time has passed since the client received it.
    const basePositionMs = state.position_ms || 0;
    if (state.status !== 'playing') {
      return Math.max(0, basePositionMs);
    }

    const serverNowMs = estimatedServerNowMs(monoMs);
    if (serverNowMs !== null && state.server_state_at_ms !== null) {
      return Math.max(0, basePositionMs + Math.max(0, serverNowMs - state.server_state_at_ms));
    }

    const serverElapsedBeforeEmitMs = (
      state.server_state_at_ms !== null && state.server_sent_ms
        ? Math.max(0, state.server_sent_ms - state.server_state_at_ms)
        : 0
    );
    const localElapsedAfterReceiveMs = Math.max(0, monoMs - fallbackReceivedMonoMs);
    return Math.max(0, basePositionMs + serverElapsedBeforeEmitMs + localElapsedAfterReceiveMs);
  }

  function currentPositionMs() {
    return projectedPositionMs(lastState);
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

  function shouldAcceptState(nextState) {
    // `revision` orders authoritative room events. `server_sent_ms` breaks ties
    // for same-revision snapshots such as heartbeat corrections.
    const nextRevision = nextState.revision || 0;
    const currentRevision = lastState.revision || 0;
    if (nextRevision < currentRevision) {
      return false;
    }
    if (nextRevision === currentRevision) {
      return (nextState.server_sent_ms || 0) >= (lastState.server_sent_ms || 0);
    }
    return true;
  }

  function applyIncomingState(state) {
    if (!state) {
      return;
    }

    const nextState = { ...emptyState(), ...state };
    if (!shouldAcceptState(nextState)) {
      return;
    }

    const monoMs = nowMonoMs();
    lastState = nextState;
    lastStateReceivedMonoMs = monoMs;
    setControlsEnabled(Boolean(nextState.url));
    refreshStatus();

    // Apply every accepted authoritative state to the iframe so the rendered
    // player never diverges from the latest server snapshot.
    if (nextState.url) {
      renderPlayer(
        nextState.url,
        nextState.status === 'playing',
        roundMs(projectedPositionMs(nextState, monoMs, monoMs)),
      );
    }
  }

  function updateClockSync(ack, clientReceivedMonoMs) {
    if (!ack || ack.ok !== true) {
      return false;
    }
    const clientSentMonoMs = Number(ack.client_sent_mono_ms);
    const serverRecvMs = Number(ack.server_recv_ms);
    const serverSendMs = Number(ack.server_send_ms);
    if ([clientSentMonoMs, serverRecvMs, serverSendMs].some(Number.isNaN)) {
      return false;
    }

    // NTP-style offset estimation maps local monotonic time onto the
    // server-owned timeline used by all playback math.
    const sampleRttMs = Math.max(0, (clientReceivedMonoMs - clientSentMonoMs) - (serverSendMs - serverRecvMs));
    const sampleOffsetMs = ((serverRecvMs - clientSentMonoMs) + (serverSendMs - clientReceivedMonoMs)) / 2;

    const previousOffsetMs = clockOffsetMs;
    estimatedRttMs = smooth(estimatedRttMs, sampleRttMs, RTT_SMOOTHING);
    clockOffsetMs = smooth(clockOffsetMs, sampleOffsetMs, CLOCK_SMOOTHING);
    if (previousOffsetMs === null) {
      return true;
    }
    return Math.abs(clockOffsetMs - previousOffsetMs) >= OFFSET_REAPPLY_THRESHOLD_MS;
  }

  function describePlayback() {
    const positionSeconds = Math.round(currentPositionMs() / 1000);
    const stateLabel = lastState.status || 'unknown';
    const stateClock = lastState.server_state_at_ms
      ? clockFormatter.format(new Date(lastState.server_state_at_ms))
      : '--:--:--';
    const videoLabel = lastState.url ? 'video loaded' : 'no video';
    const syncLabel = estimatedRttMs === null ? 'clock=warming' : `rtt=${roundMs(estimatedRttMs)}ms`;
    return `${connectionStatus}: ${stateLabel} | t=${positionSeconds}s | ${videoLabel} | revision=${lastState.revision || 0} | state_at=${stateClock} | ${syncLabel}`;
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
    const clientSentMonoMs = roundMs(nowMonoMs());
    const observedServerMs = estimatedServerNowMs(clientSentMonoMs);
    const heartbeat = {
      url: lastState.url,
      status: lastState.status,
      position_ms: roundMs(currentPositionMs()),
      observed_server_ms_est: observedServerMs === null ? null : roundMs(observedServerMs),
      client_sent_mono_ms: clientSentMonoMs,
    };
    socket.emit('heartbeat', heartbeat, (ack) => {
      const clientReceivedMonoMs = nowMonoMs();
      const shouldReapplyState = updateClockSync(ack, clientReceivedMonoMs);
      if (ack && ack.correction) {
        applyIncomingState(ack.correction);
      } else if (shouldReapplyState && lastState.url && lastState.status === 'playing') {
        applyIncomingState(lastState);
      }
      refreshStatus();
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
    applyIncomingState(state);
  });

  function emitControl(type, position_ms) {
    if (!lastState.url) {
      setStatus('Load a video before using playback controls');
      return;
    }
    // Controls carry the client's best estimate of "what time on the server
    // timeline did this click happen?". The server clamps that estimate before
    // committing it as authoritative room state.
    const eventServerMs = estimatedServerNowMs(nowMonoMs());
    const positionMs = position_ms ?? roundMs(currentPositionMs());
    socket.emit('control', {
      type,
      position_ms: positionMs,
      event_server_ms_est: eventServerMs === null ? null : roundMs(eventServerMs),
    });
  }

  if (playBtn) playBtn.addEventListener('click', () => emitControl('play'));
  if (pauseBtn) pauseBtn.addEventListener('click', () => emitControl('pause'));
  if (seekBtn) seekBtn.addEventListener('click', () => emitControl('seek', 10000));

  // Periodically show the local playback status (play/pause, seconds, current clock).
  setInterval(refreshStatus, 1000);
  setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
  refreshStatus();
});
