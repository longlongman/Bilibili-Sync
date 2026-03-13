document.addEventListener('DOMContentLoaded', () => {
  const loginForm = document.getElementById('login-form');
  const loginError = document.getElementById('login-error');
  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      loginError.textContent = '';
      const password = document.getElementById('password').value;
      try {
        const resp = await fetch('/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password }),
        });
        if (resp.ok) {
          window.location.href = '/';
          return;
        }
        const data = await resp.json();
        loginError.textContent = data.error || 'Login failed';
      } catch (err) {
        loginError.textContent = 'Network error';
      }
    });
  }

  const logoutForm = document.getElementById('logout-form');
  if (logoutForm) {
    logoutForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      await fetch('/logout', { method: 'POST' });
      window.location.href = '/login';
    });
  }
});
