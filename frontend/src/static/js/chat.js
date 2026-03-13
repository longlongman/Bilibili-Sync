document.addEventListener('DOMContentLoaded', () => {
  if (!window.io) return;

  const socket = window.appSocket || io({ withCredentials: true });
  window.appSocket = socket;

  const form = document.getElementById('chat-form');
  const input = document.getElementById('chat-input');
  const sendBtn = document.getElementById('chat-send');
  const list = document.getElementById('chat-messages');
  const statusEl = document.getElementById('chat-status');
  const indicator = document.getElementById('chat-new-indicator');

  if (!form || !input || !list || !sendBtn || !statusEl) return;

  const messagesById = new Map();
  let unreadCount = 0;

  const setStatus = (text, tone = 'info') => {
    statusEl.textContent = text;
    statusEl.dataset.tone = tone;
  };

  const isNearBottom = () => {
    const threshold = 40;
    return list.scrollHeight - list.scrollTop - list.clientHeight <= threshold;
  };

  const showIndicator = () => {
    if (!indicator) return;
    unreadCount += 1;
    indicator.hidden = false;
    indicator.textContent = `New messages (${unreadCount})`;
  };

  const clearIndicator = () => {
    if (!indicator) return;
    unreadCount = 0;
    indicator.hidden = true;
  };

  const renderMessage = (message, { fromHistory = false } = {}) => {
    if (!message || !message.message_id) return;
    if (messagesById.has(message.message_id)) return;

    const atBottom = isNearBottom();
    messagesById.set(message.message_id, message);
    const item = document.createElement('div');
    item.className = 'chat-message';
    item.dataset.messageId = message.message_id;

    const meta = document.createElement('div');
    meta.className = 'chat-meta';
    const time = message.sent_at ? new Date(message.sent_at).toLocaleTimeString() : '';
    meta.textContent = `${message.sender_label || 'User'} • ${time}`.trim();

    const body = document.createElement('div');
    body.className = 'chat-body';
    body.textContent = message.content;

    item.appendChild(meta);
    item.appendChild(body);
    list.appendChild(item);

    if (fromHistory || atBottom) {
      list.scrollTop = list.scrollHeight;
      clearIndicator();
    } else {
      showIndicator();
    }
  };

  socket.on('chat:message', (payload) => {
    renderMessage(payload);
  });

  socket.on('chat:history', (payload) => {
    const messages = (payload && payload.messages) || [];
    messages.forEach((m) => renderMessage(m, { fromHistory: true }));
  });

  list.addEventListener('scroll', () => {
    if (isNearBottom()) {
      clearIndicator();
    }
  });

  if (indicator) {
    indicator.addEventListener('click', () => {
      list.scrollTop = list.scrollHeight;
      clearIndicator();
    });
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) {
      setStatus('Message cannot be empty', 'error');
      return;
    }
    sendBtn.disabled = true;
    setStatus('Sending...', 'info');
    const payload = {
      content: text,
      client_reported_at: new Date().toISOString(),
    };
    socket.emit('chat:send', payload, (ack) => {
      sendBtn.disabled = false;
      if (!ack || ack.ok !== true) {
        const msg = (ack && (ack.error || ack.code)) || 'Send failed';
        setStatus(msg, 'error');
        return;
      }
      renderMessage(ack.message);
      input.value = '';
      setStatus('Sent', 'success');
    });
  });
});
