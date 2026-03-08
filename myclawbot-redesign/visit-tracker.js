(() => {
  try {
    const key = 'ocb_visit_sent_' + location.pathname;
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, '1');

    const payload = {
      ua: navigator.userAgent || '',
      lang: navigator.language || '',
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
      screen: `${screen.width}x${screen.height}`,
      path: location.pathname,
      ref: document.referrer || ''
    };

    fetch('/__visit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true
    }).catch(() => {});
  } catch (_) {}
})();
