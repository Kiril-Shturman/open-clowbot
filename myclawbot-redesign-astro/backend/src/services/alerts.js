export async function sendOpsAlert(text) {
  const chatId = process.env.ALERT_TELEGRAM_CHAT_ID;
  const botToken = process.env.ALERT_TELEGRAM_BOT_TOKEN;

  const msg = `[myclawbot] ${text}`;
  console.error(msg);

  if (!chatId || !botToken) return;

  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: msg.slice(0, 3900),
        disable_web_page_preview: true,
      }),
    });
  } catch (e) {
    console.error('sendOpsAlert failed:', String(e.message || e));
  }
}
