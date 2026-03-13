export function showNotification(message) {
  const status = document.getElementById('video-message');
  if (status) {
    status.textContent = message;
  }
}
