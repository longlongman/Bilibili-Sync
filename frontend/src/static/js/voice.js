/**
 * Voice chat module using WebRTC Mesh (P2P) architecture.
 * Each user connects directly to all other users for audio.
 */

(function () {
  'use strict';

  const DEFAULT_ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];
  const JOIN_TIMEOUT_MS = 10000;
  const DISCONNECT_GRACE_PERIOD_MS = 5000;
  const RECONNECT_DELAY_MS = 1000;

  let socket = null;
  let localStream = null;
  let peers = new Map(); // sid -> peer state
  let audioElements = new Map(); // sid -> HTMLAudioElement
  let signalChains = new Map(); // sid -> Promise
  let isInVoice = false;
  let isMuted = false;
  let isJoining = false;
  let shouldRejoinVoice = false;
  let initialized = false;

  // DOM elements
  let voiceBtn = null;
  let voiceStatusEl = null;

  function resolveIceServers() {
    const configured = window.__APP_CONFIG__?.voice?.iceServers;
    return Array.isArray(configured) && configured.length > 0
      ? configured
      : DEFAULT_ICE_SERVERS;
  }

  function resolveIceTransportPolicy() {
    const configured = window.__APP_CONFIG__?.voice?.iceTransportPolicy;
    return configured === 'relay' ? 'relay' : 'all';
  }

  const ICE_SERVERS = resolveIceServers();
  const ICE_TRANSPORT_POLICY = resolveIceTransportPolicy();

  function buildPeerState(sid) {
    return {
      sid,
      pc: null,
      pendingCandidates: [],
      remoteDescriptionSet: false,
      disconnectTimer: null,
      reconnectInFlight: false,
      hasRemoteTrack: false,
    };
  }

  function getOrCreatePeerState(sid) {
    let peer = peers.get(sid);
    if (!peer) {
      peer = buildPeerState(sid);
      peers.set(sid, peer);
    }
    return peer;
  }

  function clearDisconnectTimer(peer) {
    if (peer?.disconnectTimer) {
      clearTimeout(peer.disconnectTimer);
      peer.disconnectTimer = null;
    }
  }

  function isPeerConnected(peer) {
    if (!peer?.pc) {
      return false;
    }

    return (
      peer.hasRemoteTrack ||
      peer.pc.connectionState === 'connected' ||
      peer.pc.iceConnectionState === 'connected' ||
      peer.pc.iceConnectionState === 'completed'
    );
  }

  function refreshVoiceStatus() {
    if (isJoining) {
      updateStatus('Joining voice...', 'info');
      return;
    }

    if (!isInVoice && !shouldRejoinVoice) {
      updateStatus('', '');
      return;
    }

    if (!socket || !socket.connected) {
      updateStatus('Voice reconnecting...', 'info');
      return;
    }

    if (!isInVoice) {
      updateStatus('Rejoining voice...', 'info');
      return;
    }

    const peerStates = Array.from(peers.values());
    const remotePeerCount = peerStates.length;
    const connectedPeerCount = peerStates.filter(isPeerConnected).length;
    const connectingPeerCount = peerStates.filter((peer) => (
      !isPeerConnected(peer) &&
      (peer.pc !== null || peer.pendingCandidates.length > 0 || peer.reconnectInFlight)
    )).length;

    if (remotePeerCount === 0) {
      updateStatus('Joined voice, waiting for others', 'info');
      return;
    }

    if (connectedPeerCount > 0) {
      updateStatus(`Voice connected (${connectedPeerCount}/${remotePeerCount})`, 'success');
      return;
    }

    if (connectingPeerCount > 0) {
      updateStatus('Connecting voice...', 'info');
      return;
    }

    updateStatus('Joined voice, waiting for peers', 'info');
  }

  function cleanupAudioElement(sid) {
    const audio = audioElements.get(sid);
    if (audio) {
      audio.pause();
      audio.srcObject = null;
      audioElements.delete(sid);
    }
  }

  function removePeerConnection(sid, options = {}) {
    const {
      keepPendingCandidates = false,
      keepPeerState = false,
      clearAudio = true,
    } = options;
    const peer = peers.get(sid);
    if (!peer) {
      return;
    }

    clearDisconnectTimer(peer);

    if (peer.pc) {
      peer.pc.ontrack = null;
      peer.pc.onicecandidate = null;
      peer.pc.onconnectionstatechange = null;
      peer.pc.oniceconnectionstatechange = null;
      peer.pc.close();
      peer.pc = null;
    }

    peer.remoteDescriptionSet = false;
    peer.hasRemoteTrack = false;
    if (!keepPendingCandidates) {
      peer.pendingCandidates = [];
    }

    if (clearAudio) {
      cleanupAudioElement(sid);
    }

    if (!keepPeerState) {
      peers.delete(sid);
    }

    refreshVoiceStatus();
  }

  function cleanupAllConnections(options = {}) {
    const { preservePeerStates = false } = options;
    Array.from(peers.keys()).forEach((sid) => {
      removePeerConnection(sid, { keepPeerState: preservePeerStates });
    });
  }

  function syncPeersWithParticipants(participants) {
    const activeRemoteSids = new Set(
      (participants || [])
        .map((participant) => participant.sid)
        .filter((sid) => sid && sid !== socket.id),
    );

    Array.from(peers.keys()).forEach((sid) => {
      if (!activeRemoteSids.has(sid)) {
        removePeerConnection(sid);
      }
    });
  }

  function queueSignal(fromSid, data) {
    const current = signalChains.get(fromSid) || Promise.resolve();
    const next = current
      .catch(() => undefined)
      .then(() => handleSignal(fromSid, data));

    signalChains.set(fromSid, next);
    next.finally(() => {
      if (signalChains.get(fromSid) === next) {
        signalChains.delete(fromSid);
      }
    });
  }

  function emitWithAck(eventName, payload, timeoutMs = JOIN_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (!socket || !socket.connected) {
        reject(new Error('socket disconnected'));
        return;
      }

      let settled = false;
      const timeoutId = window.setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        reject(new Error(`${eventName} timeout`));
      }, timeoutMs);

      socket.emit(eventName, payload, (response) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeoutId);
        resolve(response);
      });
    });
  }

  /**
   * Initialize voice chat functionality.
   */
  function initVoiceChat() {
    if (initialized) {
      return;
    }

    if (!window.io) {
      console.warn('[Voice] Socket.IO not available');
      return;
    }

    socket = window.appSocket || io({ withCredentials: true });
    window.appSocket = socket;

    // Get DOM elements
    voiceBtn = document.getElementById('voice-btn');
    voiceStatusEl = document.getElementById('voice-status');

    if (!socket || !voiceBtn) {
      console.warn('[Voice] Required elements not found');
      return;
    }

    initialized = true;
    setupEventListeners();
    console.log('[Voice] Initialized');
  }

  /**
   * Set up socket event listeners.
   */
  function setupEventListeners() {
    socket.on('voice:user_joined', (payload) => {
      if (!payload) {
        return;
      }

      console.log('[Voice] User joined:', payload.sid, 'my id:', socket.id);
      if (payload.sid === socket.id) {
        return;
      }

      if (isInVoice && Array.isArray(payload.participants)) {
        syncPeersWithParticipants(payload.participants);
      }
      refreshVoiceStatus();
    });

    socket.on('voice:user_left', (payload) => {
      if (!payload) {
        return;
      }

      console.log('[Voice] User left:', payload);
      if (payload.sid === socket.id) {
        cleanupAllConnections();
      } else {
        removePeerConnection(payload.sid);
      }

      refreshVoiceStatus();
    });

    socket.on('voice:signal', (payload) => {
      if (!payload?.from_sid || !payload?.data) {
        return;
      }

      console.log('[Voice] Received signal from:', payload.from_sid);
      queueSignal(payload.from_sid, payload.data);
    });

    socket.on('disconnect', () => {
      if (shouldRejoinVoice) {
        isInVoice = false;
        cleanupAllConnections();
      }
      refreshVoiceStatus();
    });

    socket.on('connect', () => {
      if (shouldRejoinVoice && localStream && !isInVoice && !isJoining) {
        attemptVoiceJoin(true);
        return;
      }

      refreshVoiceStatus();
    });

    voiceBtn.addEventListener('click', toggleVoice);

    const muteBtn = document.getElementById('voice-mute-btn');
    if (muteBtn) {
      muteBtn.addEventListener('click', toggleMicrophone);
    }
  }

  async function ensureLocalStream() {
    if (localStream) {
      return localStream;
    }

    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });

    localStream.getAudioTracks().forEach((track) => {
      track.enabled = !isMuted;
    });

    return localStream;
  }

  /**
   * Toggle voice chat on/off.
   */
  async function toggleVoice() {
    if (!socket || !socket.connected) {
      updateStatus('Not connected', 'error');
      return;
    }

    if (isInVoice || shouldRejoinVoice) {
      await leaveVoice();
    } else {
      await joinVoice();
    }
  }

  async function attemptVoiceJoin(isReconnect) {
    if (isJoining || !socket || !socket.connected || !localStream) {
      return;
    }

    isJoining = true;
    refreshVoiceStatus();

    try {
      const response = await emitWithAck('voice:join', {});
      if (!response?.ok) {
        throw new Error(response?.error || 'unknown');
      }

      isInVoice = true;
      shouldRejoinVoice = true;
      updateVoiceButton(true);
      updateMuteButtonEnabled(true);

      const participants = response.participants || [];
      syncPeersWithParticipants(participants);
      await setupPeerConnections(participants);
      refreshVoiceStatus();
    } catch (err) {
      console.error('[Voice] Join failed:', err);
      isInVoice = false;
      if (isReconnect) {
        updateStatus('Voice reconnect failed, retrying...', 'error');
        window.setTimeout(() => {
          if (shouldRejoinVoice && socket.connected && localStream && !isInVoice && !isJoining) {
            attemptVoiceJoin(true);
          }
        }, RECONNECT_DELAY_MS);
      } else {
        shouldRejoinVoice = false;
        cleanupAllConnections();
        cleanupLocalStream();
        updateVoiceButton(false);
        updateMuteButtonEnabled(false);
        updateStatus(`Failed to join: ${err.message || 'unknown'}`, 'error');
      }
    } finally {
      isJoining = false;
      refreshVoiceStatus();
    }
  }

  /**
   * Join voice chat.
   */
  async function joinVoice() {
    if (isJoining || isInVoice) {
      return;
    }

    try {
      updateStatus('Requesting microphone...', 'info');
      await ensureLocalStream();
      shouldRejoinVoice = true;
      await attemptVoiceJoin(false);
    } catch (err) {
      shouldRejoinVoice = false;
      console.error('[Voice] Microphone error:', err);
      let message = 'Microphone access denied';
      if (err.name === 'NotAllowedError') {
        message = 'Please allow microphone access to use voice chat';
      } else if (err.name === 'NotFoundError') {
        message = 'No microphone found';
      }
      cleanupLocalStream();
      updateStatus(message, 'error');
    }
  }

  /**
   * Leave voice chat.
   */
  async function leaveVoice() {
    shouldRejoinVoice = false;
    isJoining = false;
    isInVoice = false;

    if (socket && socket.connected) {
      try {
        await emitWithAck('voice:leave', {}, 3000);
      } catch (err) {
        console.warn('[Voice] Leave voice ack failed:', err);
      }
    }

    cleanupAllConnections();
    cleanupLocalStream();

    isMuted = false;
    updateVoiceButton(false);
    updateMuteButtonEnabled(false);
    refreshVoiceStatus();
  }

  /**
   * Toggle microphone mute.
   */
  function toggleMicrophone() {
    if (!localStream || !isInVoice) {
      return;
    }

    isMuted = !isMuted;
    localStream.getAudioTracks().forEach((track) => {
      track.enabled = !isMuted;
    });

    updateMuteButton();
    console.log('[Voice] Microphone:', isMuted ? 'muted' : 'unmuted');
  }

  /**
   * Update mute button state.
   */
  function updateMuteButton() {
    const muteBtn = document.getElementById('voice-mute-btn');
    if (muteBtn) {
      muteBtn.textContent = isMuted ? 'Unmute' : 'Mute';
      muteBtn.classList.toggle('muted', isMuted);
    }
  }

  /**
   * Enable/disable mute button.
   */
  function updateMuteButtonEnabled(enabled) {
    const muteBtn = document.getElementById('voice-mute-btn');
    if (muteBtn) {
      muteBtn.disabled = !enabled;
      if (!enabled) {
        isMuted = false;
      }
      updateMuteButton();
    }
  }

  /**
   * Set up peer connections to all existing participants.
   */
  async function setupPeerConnections(participants) {
    for (const participant of participants) {
      if (participant.sid === socket.id) {
        continue;
      }

      const peer = peers.get(participant.sid);
      if (peer && isPeerConnected(peer)) {
        continue;
      }

      await createPeerConnection(participant.sid, true);
    }
  }

  function handlePeerConnectionStateChange(targetSid, pc) {
    const peer = peers.get(targetSid);
    if (!peer || peer.pc !== pc) {
      return;
    }

    const state = pc.connectionState;
    const iceState = pc.iceConnectionState;
    if (state === 'connected' || iceState === 'connected' || iceState === 'completed') {
      clearDisconnectTimer(peer);
      peer.reconnectInFlight = false;
      refreshVoiceStatus();
      return;
    }

    if (state === 'disconnected' || iceState === 'disconnected') {
      if (!peer.disconnectTimer) {
        peer.disconnectTimer = window.setTimeout(() => {
          const latestPeer = peers.get(targetSid);
          if (!latestPeer || latestPeer.pc !== pc) {
            return;
          }

          if (
            pc.connectionState === 'disconnected' ||
            pc.iceConnectionState === 'disconnected' ||
            pc.connectionState === 'failed' ||
            pc.iceConnectionState === 'failed'
          ) {
            restartPeerConnection(targetSid);
          }
        }, DISCONNECT_GRACE_PERIOD_MS);
      }
      refreshVoiceStatus();
      return;
    }

    if (state === 'failed' || iceState === 'failed') {
      clearDisconnectTimer(peer);
      restartPeerConnection(targetSid);
      return;
    }

    if (state === 'closed') {
      clearDisconnectTimer(peer);
      removePeerConnection(targetSid);
      return;
    }

    refreshVoiceStatus();
  }

  async function restartPeerConnection(targetSid) {
    const peer = getOrCreatePeerState(targetSid);
    if (peer.reconnectInFlight || !isInVoice || !localStream || !socket?.connected) {
      return;
    }

    peer.reconnectInFlight = true;
    removePeerConnection(targetSid, { keepPeerState: true });
    refreshVoiceStatus();

    window.setTimeout(async () => {
      const latestPeer = getOrCreatePeerState(targetSid);
      if (!isInVoice || !localStream || !socket?.connected) {
        latestPeer.reconnectInFlight = false;
        refreshVoiceStatus();
        return;
      }

      try {
        await createPeerConnection(targetSid, true);
      } finally {
        const refreshedPeer = peers.get(targetSid);
        if (refreshedPeer) {
          refreshedPeer.reconnectInFlight = false;
        }
        refreshVoiceStatus();
      }
    }, RECONNECT_DELAY_MS);
  }

  /**
   * Create a peer connection to a specific user.
   */
  async function createPeerConnection(targetSid, isInitiator) {
    const peer = getOrCreatePeerState(targetSid);
    if (peer.pc) {
      return peer.pc;
    }

    console.log('[Voice] Creating peer connection to:', targetSid, 'initiator:', isInitiator);

    const pc = new RTCPeerConnection({
      iceServers: ICE_SERVERS,
      iceCandidatePoolSize: 10,
      iceTransportPolicy: ICE_TRANSPORT_POLICY,
    });
    peer.pc = pc;
    peer.remoteDescriptionSet = false;
    peer.hasRemoteTrack = false;
    clearDisconnectTimer(peer);

    if (localStream) {
      localStream.getAudioTracks().forEach((track) => {
        pc.addTrack(track, localStream);
      });
    }

    pc.ontrack = (event) => {
      const latestPeer = peers.get(targetSid);
      if (!latestPeer || latestPeer.pc !== pc) {
        return;
      }

      latestPeer.hasRemoteTrack = true;
      playRemoteAudio(targetSid, event.streams[0]);
      refreshVoiceStatus();
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal(targetSid, { type: 'candidate', candidate: event.candidate });
      }
    };

    pc.onconnectionstatechange = () => {
      handlePeerConnectionStateChange(targetSid, pc);
    };

    pc.oniceconnectionstatechange = () => {
      handlePeerConnectionStateChange(targetSid, pc);
    };

    if (isInitiator) {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendSignal(targetSid, { type: 'offer', sdp: pc.localDescription });
      } catch (err) {
        console.error('[Voice] Error creating offer:', err);
        removePeerConnection(targetSid);
      }
    }

    refreshVoiceStatus();
    return pc;
  }

  async function flushPendingCandidates(peer, pc) {
    if (!peer.remoteDescriptionSet || peer.pendingCandidates.length === 0) {
      return;
    }

    const candidates = peer.pendingCandidates.slice();
    peer.pendingCandidates = [];
    for (const candidate of candidates) {
      const latestPeer = peers.get(peer.sid);
      if (!latestPeer || latestPeer.pc !== pc) {
        break;
      }

      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.error('[Voice] Error adding queued ICE candidate:', err);
      }
    }
  }

  /**
   * Handle incoming WebRTC signaling data.
   */
  async function handleSignal(fromSid, data) {
    if (!data?.type) {
      return;
    }

    if (!localStream || (!isInVoice && !shouldRejoinVoice)) {
      console.warn('[Voice] Ignoring signal while voice is inactive');
      return;
    }

    let peer = getOrCreatePeerState(fromSid);

    if (data.type === 'offer') {
      if (
        peer.pc &&
        peer.pc.signalingState !== 'stable' &&
        peer.pc.signalingState !== 'closed'
      ) {
        removePeerConnection(fromSid, {
          keepPendingCandidates: true,
          keepPeerState: true,
        });
        peer = getOrCreatePeerState(fromSid);
      }

      const pc = await createPeerConnection(fromSid, false);
      if (!pc) {
        console.error('[Voice] Failed to create peer connection for offer');
        return;
      }

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        peer.remoteDescriptionSet = true;
        await flushPendingCandidates(peer, pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendSignal(fromSid, { type: 'answer', sdp: pc.localDescription });
      } catch (err) {
        console.error('[Voice] Error handling offer:', err);
        restartPeerConnection(fromSid);
      }
    } else if (data.type === 'answer') {
      if (!peer.pc) {
        console.error('[Voice] No peer connection for answer');
        return;
      }

      if (peer.remoteDescriptionSet) {
        console.log('[Voice] Remote description already set, skipping answer');
        return;
      }

      try {
        await peer.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        peer.remoteDescriptionSet = true;
        await flushPendingCandidates(peer, peer.pc);
      } catch (err) {
        console.error('[Voice] Error handling answer:', err);
        restartPeerConnection(fromSid);
      }
    } else if (data.type === 'candidate') {
      if (!data.candidate) {
        return;
      }

      if (!peer.pc || !peer.remoteDescriptionSet) {
        peer.pendingCandidates.push(data.candidate);
        return;
      }

      try {
        await peer.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (err) {
        console.error('[Voice] Error adding ICE candidate:', err);
      }
    }
  }

  /**
   * Send signaling data to a specific user.
   */
  function sendSignal(targetSid, data) {
    if (!socket?.connected) {
      return;
    }

    socket.emit('voice:signal', {
      target_sid: targetSid,
      data,
    }, (response) => {
      if (response?.ok === false && response?.error === 'target not in voice') {
        console.warn('[Voice] Target left voice:', targetSid);
        removePeerConnection(targetSid);
      }
    });
  }

  /**
   * Play remote audio from a peer.
   */
  function playRemoteAudio(sid, stream) {
    let audio = audioElements.get(sid);

    if (!audio) {
      audio = new Audio();
      audio.autoplay = true;
      audio.playsInline = true;
      audioElements.set(sid, audio);
    }

    audio.srcObject = stream;
    audio.volume = 1.0;
    audio.muted = false;

    audio.play().catch((err) => {
      console.error('[Voice] Error playing audio:', err);
    });
  }

  /**
   * Clean up local media stream.
   */
  function cleanupLocalStream() {
    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
      localStream = null;
    }
  }

  /**
   * Update voice button appearance.
   */
  function updateVoiceButton(inVoice) {
    if (voiceBtn) {
      voiceBtn.classList.toggle('in-voice', inVoice);
      voiceBtn.textContent = inVoice ? 'Leave Voice' : 'Join Voice';
    }
  }

  /**
   * Update status display.
   */
  function updateStatus(text, tone) {
    if (voiceStatusEl) {
      voiceStatusEl.textContent = text;
      voiceStatusEl.dataset.tone = tone || '';
    }
  }

  // Expose for debugging
  window._voiceDebug = {
    getPeers() {
      return Array.from(peers.values()).map((peer) => ({
        sid: peer.sid,
        connectionState: peer.pc?.connectionState || null,
        iceConnectionState: peer.pc?.iceConnectionState || null,
        remoteDescriptionSet: peer.remoteDescriptionSet,
        pendingCandidates: peer.pendingCandidates.length,
        hasRemoteTrack: peer.hasRemoteTrack,
      }));
    },
    get isInVoice() {
      return isInVoice;
    },
    get localStream() {
      return localStream;
    },
    get iceTransportPolicy() {
      return ICE_TRANSPORT_POLICY;
    },
  };

  window.toggleVoice = toggleVoice;
  window.toggleMicrophone = toggleMicrophone;
  window.initVoiceChat = initVoiceChat;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initVoiceChat);
  } else {
    initVoiceChat();
  }
})();
