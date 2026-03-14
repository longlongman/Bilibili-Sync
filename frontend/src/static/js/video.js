document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('video-url');
  const button = document.getElementById('load-video');
  const message = document.getElementById('video-message');

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
          message.textContent = 'Video loaded';
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
