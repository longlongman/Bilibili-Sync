document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('video-url');
  const button = document.getElementById('load-video');
  const message = document.getElementById('video-message');
  const container = document.getElementById('player-container');

  function renderPlayer(url, shouldAutoplay) {
    if (!container) return;
    const target = new URL(url);
    target.searchParams.set('autoplay', shouldAutoplay ? '1' : '0');
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
    if (iframe.src !== nextSrc) {
      iframe.src = nextSrc;
    }
  }

  async function submitVideo(url) {
    const resp = await fetch('/video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    return resp;
  }

  if (button) {
    button.addEventListener('click', async () => {
      message.textContent = '';
      const url = input.value.trim();
      if (!url) {
        message.textContent = 'Please provide a Bilibili link';
        return;
      }
      button.disabled = true;
      message.textContent = 'Loading...';
      try {
        const resp = await submitVideo(url);
        const data = await resp.json();
        if (resp.ok && data.embed_url) {
          renderPlayer(data.embed_url, false);
          message.textContent = 'Video loaded';
          document.dispatchEvent(new CustomEvent('video:loaded', { detail: { url: data.embed_url } }));
        } else {
          message.textContent = data.error || 'Unable to load video';
        }
      } catch (err) {
        message.textContent = 'Network error';
      } finally {
        button.disabled = false;
      }
    });
  }
});
