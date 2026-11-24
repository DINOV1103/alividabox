// Alivida Organic — arizani Telegram'ga SERVER orqali yuborish.
// Bot tokeni sahifa kodida yo'q, faqat Vercel sozlamalarida turadi:
//   Vercel → Settings → Environment Variables
//     TG_BOT_TOKEN   = BotFather bergan YANGI token
//     TG_CHAT_ID     = -1003837735629   ("A LEAD" guruhi)
//   Ixtiyoriy:
//     ALLOWED_ORIGINS = https://alividabox.vercel.app,https://alivida.uz   (vergul bilan)
//
// Tekshirish: brauzerda  /api/lead?check=1  ni oching — token, guruh va bot holatini ko'rsatadi
// (tokenning o'zi hech qachon ko'rsatilmaydi).
//
// Spamga qarshi: boshqa saytlardan kelgan so'rov rad etiladi, yashirin "tuzoq" maydon,
// juda tez yuborilgan forma, noto'g'ri raqam, bir IP'dan ko'p ariza va bir xil raqamni
// qayta-qayta yuborish to'xtatiladi.

const https = require('https');

const PHONE_RE = /^(20|33|50|55|77|88|90|91|93|94|95|97|98|99|6[1-9]|7[0-9])\d{7}$/;
const MIN_FILL_MS = 3000;            // formani 3 soniyadan tez to'ldirib bo'lmaydi
const IP_LIMIT = 10;                 // bitta IP'dan 10 daqiqada ko'pi bilan 10 ariza (mobil operatorlarda ko'p odam bitta IP'da bo'ladi)
const WINDOW_MS = 10 * 60 * 1000;
const TG_TIMEOUT_MS = 7000;

const byIp = new Map();              // ip -> [vaqtlar]
const sentPhones = new Map();        // raqam -> muvaffaqiyatli yuborilgan vaqt

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clean = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
const envToken = () => String(process.env.TG_BOT_TOKEN || '').trim();
const envChat = () => String(process.env.TG_CHAT_ID || '').trim();

// Telegram API so'rovi: IPv4 orqali, vaqt chegarasi bilan (osilib qolmasligi uchun)
function tg(method, payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload || {});
    const req = https.request({
      host: 'api.telegram.org',
      path: `/bot${envToken()}/${method}`,
      method: 'POST',
      family: 4,
      timeout: TG_TIMEOUT_MS,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve({ ok: false, error_code: res.statusCode, description: 'bad response' }); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => { resolve({ ok: false, error_code: 0, description: e.message === 'timeout' ? 'timeout' : 'network: ' + (e.code || e.message) }); });
    req.end(body);
  });
}

function originAllowed(req) {
  const origin = String(req.headers.origin || '');
  if (!origin) return false;
  const list = String(process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length) return list.includes(origin);
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  return origin === 'https://' + host;
}

function tooMany(ip, now) {
  const list = (byIp.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  byIp.set(ip, list);
  return list.length > IP_LIMIT;
}

module.exports = async (req, res) => {
  // --- tekshiruv: /api/lead?check=1 ---
  const query = req.query || {};
  if (req.method === 'GET' && query.check !== undefined) {
    const out = { token_set: !!envToken(), chat_set: !!envChat(), chat_id: envChat() || null };
    if (out.token_set) {
      const me = await tg('getMe');
      out.bot = me.ok ? '@' + me.result.username : 'XATO: ' + (me.description || me.error_code);
      if (me.ok && out.chat_set) {
        const ch = await tg('getChat', { chat_id: envChat() });
        out.group = ch.ok ? ch.result.title : 'XATO: ' + (ch.description || ch.error_code);
      }
    }
    res.status(200).json(out);
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'POST only' });
    return;
  }

  if (!envToken() || !envChat()) {
    res.status(500).json({ ok: false, error: 'env' });
    return;
  }

  if (!originAllowed(req)) {
    res.status(403).json({ ok: false, error: 'origin' });
    return;
  }

  let b = req.body || {};
  if (typeof b === 'string') {
    try { b = JSON.parse(b); } catch (e) { b = {}; }
  }

  // Botlar: javob "ok", lekin hech narsa yuborilmaydi (bot buni sezmaydi)
  if (clean(b.website, 200)) { res.status(200).json({ ok: true }); return; }
  if (!(Number(b.t) >= MIN_FILL_MS)) { res.status(200).json({ ok: true }); return; }

  const name = clean(b.name, 60);
  const phone = String(b.phone || '').replace(/\D/g, '').replace(/^998(?=\d{9}$)/, '');
  const detail = clean(b.detail, 200);
  const whom = clean(b.whom, 100);

  if (name.length < 2 || !PHONE_RE.test(phone) || /^(\d)\1+$/.test(phone.slice(2)) || !detail || !whom) {
    res.status(400).json({ ok: false, error: 'input' });
    return;
  }

  const now = Date.now();
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (tooMany(ip, now)) { res.status(429).json({ ok: false, error: 'limit' }); return; }

  // Shu raqam 10 daqiqa ichida MUVAFFAQIYATLI yuborilgan bo'lsa — takror, qayta yubormaymiz
  const last = sentPhones.get(phone);
  if (last && now - last < WINDOW_MS) { res.status(200).json({ ok: true, dup: true }); return; }

  const pretty = '+998 ' + phone.replace(/^(\d{2})(\d{3})(\d{2})(\d{2})$/, '$1 $2 $3 $4');
  const time = new Date(now).toLocaleString('ru-RU', { timeZone: 'Asia/Tashkent' });
  const text =
    '🔵 <b>ЯНГИ БУЮРТМА (ALIVIDA ORGANIC)</b> 🔵\n\n' +
    '👤 <b>Исми:</b> ' + esc(name) + '\n' +
    '📞 <b>Телефони:</b> ' + esc(pretty) + '\n' +
    '🦴 <b>Оғриқ жойи:</b> ' + esc(detail) + '\n' +
    '👥 <b>Ким учун:</b> ' + esc(whom) + '\n' +
    '✅ <b>Розилик:</b> берилди\n' +
    '🕒 <b>Вақти:</b> ' + time + '\n' +
    '🌐 <b>Манба:</b> ' + esc(clean(b.source, 60) || 'Alivida Landing Page');

  const r = await tg('sendMessage', { chat_id: envChat(), text, parse_mode: 'HTML' });
  if (r.ok) {
    sentPhones.set(phone, Date.now());
    res.status(200).json({ ok: true });
  } else {
    console.error('telegram sendMessage failed:', r.error_code, r.description);
    res.status(502).json({ ok: false, error: 'tg_' + (r.error_code || (r.description === 'timeout' ? 'timeout' : 'net')) });
  }
};
