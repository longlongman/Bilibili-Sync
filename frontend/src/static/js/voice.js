/**
 * Voice chat module using WebRTC Mesh (P2P) architecture.
 * Each user connects directly to all other users for audio.
 */

(function () {
  'use strict';

  // ICE servers configuration (using STUN for NAT traversal)
  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

  let socket = null;
  let localStream = null;
  let peers = new Map(); // sid -> RTCPeerConnection
  let audioElements = new Map(); // sid -> HTMLAudioElement
  let isInVoice = false;
  let isMuted = false;
  let isJoining = false; // Prevent double join

  // DOM elements
  let voiceBtn = null;
  let voiceStatusEl = null;

  /**
   * Initialize voice chat functionality.
   */
  function initVoiceChat() {
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

    setupEventListeners();
    console.log('[Voice] Initialized');
  }

  /**
   * Set up socket event listeners.
   */
  function setupEventListeners() {
    // User joined voice
    socket.on('voice:user_joined', async (payload) => {
      console.log('[Voice] User joined:', payload.sid, 'my id:', socket.id);
      if (payload.sid === socket.id) {
        // This is me joining - already handled in joinVoice callback
        return;
      }
      // Someone else joined - wait for them to connect to us (they are the initiator)
      console.log('[Voice] Waiting for', payload.sid, 'to connect to us');
    });

    // User left voice
    socket.on('voice:user_left', (payload) => {
      console.log('[Voice] User left:', payload);
      if (payload.sid === socket.id) {
        // This is me leaving, clean up all connections
        cleanupAllConnections();
      } else {
        // Someone else left, remove their connection
        removePeerConnection(payload.sid);
      }
    });

    // WebRTC signaling
    socket.on('voice:signal', async (payload) => {
      console.log('[Voice] Received signal from:', payload.from_sid);
      await handleSignal(payload.from_sid, payload.data);
    });

    // Voice button click
    voiceBtn.addEventListener('click', toggleVoice);

    // Mute button click
    const muteBtn = document.getElementById('voice-mute-btn');
    if (muteBtn) {
      muteBtn.addEventListener('click', toggleMicrophone);
    }
  }

  /**
   * Toggle voice chat on/off.
   */
  async function toggleVoice() {
    // Join or leave the shared voice mesh depending on the current state.
    if (!socket || !socket.connected) {
      updateStatus('Not connected', 'error');
      return;
    }

    if (isInVoice) {
      await leaveVoice();
    } else {
      await joinVoice();
    }
  }

  /**
   * Join voice chat.
   */
  async function joinVoice() {
    // Capture microphone audio, announce presence, and connect to peers.
    if (isJoining || isInVoice) return; // Prevent double join
    isJoining = true;

    try {
      updateStatus('Requesting microphone...', 'info');

      // Request microphone access
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });

      // Mute local audio (we don't need to hear ourselves)
      localStream.getAudioTracks().forEach((track) => {
        track.enabled = !isMuted;
      });

      // Emit join event
      socket.emit('voice:join', {}, (response) => {
        // Ignore if timeout already handled
        if (!isJoining) return;
        isJoining = false;
        if (!response || !response.ok) {
          console.error('[Voice] Join failed:', response);
          cleanupLocalStream();
          updateStatus('Failed to join: ' + (response?.error || 'unknown'), 'error');
          return;
        }

        isInVoice = true;
        updateVoiceButton(true);
        updateMuteButtonEnabled(true);
        updateStatus('In voice chat', 'success');

        // Set up connections to existing participants
        const participants = response.participants || [];
        setupPeerConnections(participants);

        console.log('[Voice] Joined, participants:', participants.length);
      });

      // Timeout fallback - in case callback is never called
      setTimeout(() => {
        if (isJoining) {
          isJoining = false;
          cleanupLocalStream();
          updateStatus('Join timeout', 'error');
        }
      }, 10000);
    } catch (err) {
      isJoining = false;
      console.error('[Voice] Microphone error:', err);
      let message = 'Microphone access denied';
      if (err.name === 'NotAllowedError') {
        message = 'Please allow microphone access to use voice chat';
      } else if (err.name === 'NotFoundError') {
        message = 'No microphone found';
      }
      updateStatus(message, 'error');
    }
  }

  /**
   * Leave voice chat.
   */
  async function leaveVoice() {
    // Leave the voice room and tear down all local media resources.
    if (!isInVoice) return;

    isJoining = false;

    socket.emit('voice:leave', {}, (response) => {
      console.log('[Voice] Left voice chat');
    });

    cleanupAllConnections();
    cleanupLocalStream();

    isInVoice = false;
    isMuted = false;
    updateVoiceButton(false);
    updateMuteButtonEnabled(false);
    updateStatus('', '');
  }

  /**
   * Toggle microphone mute.
   */
  function toggleMicrophone() {
    if (!localStream || !isInVoice) return;

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
      isMuted = false;
      updateMuteButton();
    }
  }

  /**
   * Set up peer connections to all existing participants.
   */
  async function setupPeerConnections(participants) {
    // Ensure there is one outbound peer connection for each existing participant.
    for (const participant of participants) {
      if (participant.sid === socket.id) continue;

      const existingPc = peers.get(participant.sid);
      if (existingPc) {
        // Only skip if connection is successfully established
        if (existingPc.connectionState === 'connected' || existingPc.connectionState === 'completed') {
          continue;
        }
        // Remove stale connection and recreate
        removePeerConnection(participant.sid);
      }

      await createPeerConnection(participant.sid, true);
    }
  }

  /**
   * Create a peer connection to a specific user.
   */
  async function createPeerConnection(targetSid, isInitiator) {
    // Create and configure one RTCPeerConnection for a remote participant.
    if (peers.has(targetSid)) {
      console.log('[Voice] Peer already exists:', targetSid);
      return;
    }

    console.log('[Voice] Creating peer connection to:', targetSid, 'initiator:', isInitiator);

    const pc = new RTCPeerConnection({
      iceServers: ICE_SERVERS,
      iceCandidatePoolSize: 10
    });
    peers.set(targetSid, pc);

    // Add local stream tracks to the connection
    if (localStream) {
      localStream.getAudioTracks().forEach((track) => {
        pc.addTrack(track, localStream);
      });
    }

    // Handle incoming audio
    pc.ontrack = (event) => {
      const remoteStream = event.streams[0];
      playRemoteAudio(targetSid, remoteStream);
    };

    // Handle ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal(targetSid, { type: 'candidate', candidate: event.candidate });
      }
    };

    // Handle connection state changes
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.iceConnectionState === 'failed') {
        removePeerConnection(targetSid);
        setTimeout(() => {
          if (isInVoice && localStream) {
            createPeerConnection(targetSid, true);
          }
        }, 1000);
      } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
        removePeerConnection(targetSid);
      }
    };

    // If we're the initiator, create and send offer
    if (isInitiator) {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendSignal(targetSid, { type: 'offer', sdp: pc.localDescription });
      } catch (err) {
        removePeerConnection(targetSid);
      }
    }

    return pc;
  }

  /**
   * Handle incoming WebRTC signaling data.
   */
  async function handleSignal(fromSid, data) {
    // Apply incoming WebRTC offers, answers, and ICE candidates.
    let pc = peers.get(fromSid);

    if (data.type === 'offer') {
      // Create peer connection if doesn't exist
      if (!pc) {
        await createPeerConnection(fromSid, false);
        pc = peers.get(fromSid);
      }

      if (!pc) {
        console.error('[Voice] Failed to create peer connection for offer');
        return;
      }

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendSignal(fromSid, { type: 'answer', sdp: pc.localDescription });
      } catch (err) {
        console.error('[Voice] Error handling offer:', err);
      }
    } else if (data.type === 'answer') {
      if (!pc) {
        console.error('[Voice] No peer connection for answer');
        return;
      }

      // Check if we already have a remote description to avoid InvalidStateError
      if (pc.remoteDescription) {
        console.log('[Voice] Remote description already set, skipping answer');
        return;
      }

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      } catch (err) {
        console.error('[Voice] Error handling answer:', err);
      }
    } else if (data.type === 'candidate') {
      if (!pc) {
        console.error('[Voice] No peer connection for candidate');
        return;
      }

      try {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (err) {
        console.error('[Voice] Error adding ICE candidate:', err);
      }
    }
  }

  /**
   * Send signaling data to a specific user.
   */
  function sendSignal(targetSid, data) {
    socket.emit('voice:signal', {
      target_sid: targetSid,
      data: data,
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
   * Remove a peer connection.
   */
  function removePeerConnection(sid) {
    const pc = peers.get(sid);
    if (pc) {
      pc.close();
      peers.delete(sid);
    }

    const audio = audioElements.get(sid);
    if (audio) {
      audio.pause();
      audio.srcObject = null;
      audioElements.delete(sid);
    }

    console.log('[Voice] Removed peer:', sid);
  }

  /**
   * Clean up all peer connections.
   */
  function cleanupAllConnections() {
    peers.forEach((pc, sid) => {
      pc.close();
    });
    peers.clear();

    audioElements.forEach((audio) => {
      audio.pause();
      audio.srcObject = null;
    });
    audioElements.clear();
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
    peers,
    audioElements,
    isInVoice,
    localStream
  };

  // Expose functions globally for HTML onclick handlers
  window.toggleVoice = toggleVoice;
  window.toggleMicrophone = toggleMicrophone;
  window.initVoiceChat = initVoiceChat;

  // Auto-initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initVoiceChat);
  } else {
    initVoiceChat();
  }
})();
