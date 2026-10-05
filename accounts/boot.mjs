// A quiet module boundary: top-level failures should leave a useful message, not a blank page.
window.addEventListener('unhandledrejection', event => {
  const toast = document.getElementById('toast');
  if (toast) { toast.textContent = 'Something interrupted the app. Refresh to check for a pending save.'; toast.className = 'show error'; }
});
