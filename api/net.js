// Diagnostika: oddiy (Node) serverless funksiyadan internetga chiqish tekshiruvi.
// Brauzerda /api/net ni oching. Hech qanday maxfiy ma'lumot ko'rsatmaydi.

async function timed(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const t0 = Date.now();
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    return 'ok ' + r.status + ' ' + (Date.now() - t0) + 'ms';
  } catch (e) {
    return 'XATO: ' + (e.name === 'AbortError' ? 'timeout' : ((e.cause && e.cause.code) || e.message)) + ' ' + (Date.now() - t0) + 'ms';
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async (req, res) => {
  const tok = String(process.env.TG_BOT_TOKEN || '').trim();
  const [google, telegram, meta, invalid_token, bot_getme] = await Promise.all([
    timed('https://www.google.com/generate_204', 6000),
    timed('https://api.telegram.org/', 6000),
    timed('https://graph.facebook.com/', 6000),
    timed('https://api.telegram.org/bot1:invalid/getMe', 8000),
    tok ? timed(`https://api.telegram.org/bot${tok}/getMe`, 8000) : Promise.resolve('no token'),
  ]);
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    runtime: 'node', region: process.env.VERCEL_REGION || 'unknown',
    token_bot_id: (tok.split(':')[0] || '').replace(/\D/g, '') || null,
    google, telegram, meta, invalid_token, bot_getme,
  });
};
