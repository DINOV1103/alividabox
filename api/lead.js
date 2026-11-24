// Alivida Organic — arizani Telegram guruhiga Vercel SERVERI orqali yuborish (Edge funksiya).
//
// Bot tokeni sahifa kodida ham, GitHub'da ham YO'Q — faqat Vercel sozlamalarida turadi:
//   Vercel → Settings → Environment Variables
//     TG_BOT_TOKEN = BotFather bergan token
//     TG_CHAT_ID   = guruh ID'si (-100... ko'rinishida)
//   Ixtiyoriy:
//     ALLOWED_ORIGINS = https://alividabox.vercel.app,https://alivida.uz   (vergul bilan)
//   MUHIM: qiymatni o'zgartirgandan keyin Deployments → ⋯ → Redeploy qiling.
//
// Tekshirish: brauzerda  /api/lead?check=1  (token ko'rsatilmaydi, guruhga hech narsa yuborilmaydi).
//
// Spamga qarshi: boshqa saytlardan kelgan so'rov, yashirin "tuzoq" maydon, 3 soniyadan tez
// to'ldirilgan forma, bitta IP'dan ko'p ariza va bir raqamning qayta-qayta kelishi to'xtatiladi.

export const config = { runtime: 'edge' };

const PHONE_RE = /^\d{9}$/;          // istalgan 9 xonali raqam
const MIN_FILL_MS = 3000;
const IP_LIMIT = 10;                 // bitta IP'dan 10 daqiqada ko'pi bilan 10 ariza
const WINDOW_MS = 10 * 60 * 1000;
const TG_TIMEOUT_MS = 10000;

const byIp = new Map();
const sentPhones = new Map();

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clean = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
// Token ko'chirilganda tasodifan qo'shilgan qo'shtirnoq, bo'sh joy yoki "bot" so'zi olib tashlanadi
const envToken = () => String(process.env.TG_BOT_TOKEN || '').trim().replace(/^['"]|['"]$/g, '').replace(/^bot/, '').trim();
const envChat = () => String(process.env.TG_CHAT_ID || '').trim().replace(/^['"]|['"]$/g, '');

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

async function tg(method, payload) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TG_TIMEOUT_MS);
  try {
    const r = await fetch(`https://api.telegram.org/bot${envToken()}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}), signal: ctrl.signal,
    });
    return await r.json().catch(() => ({ ok: false, error_code: r.status, description: 'bad response' }));
  } catch (e) {
    return { ok: false, error_code: 0, description: e.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

// Telegram xatosini qisqa kodga aylantiradi: tg_401, tg_429_32s, tg_timeout ...
function tgError(r) {
  if (r.description === 'timeout') return 'tg_timeout';
  const wait = r.parameters && r.parameters.retry_after ? '_' + r.parameters.retry_after + 's' : '';
  return 'tg_' + (r.error_code || 'net') + wait;
}

function originAllowed(req) {
  const origin = req.headers.get('origin') || '';
  if (!origin) return false;
  const list = String(process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length) return list.includes(origin);
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || '';
  return origin === 'https://' + host;
}

function tooMany(ip, now) {
  const list = (byIp.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  byIp.set(ip, list);
  if (byIp.size > 5000) byIp.clear();
  return list.length > IP_LIMIT;
}

async function check() {
  const token = envToken();
  const chat = envChat();
  const out = {
    token_set: !!token,
    bot_id: token ? token.split(':')[0] : null,
    chat_set: !!chat,
    chat_id: chat ? chat.slice(0, 4) + '…' + chat.slice(-3) : null,
  };
  if (!token) return out;
  const me = await tg('getMe');
  out.bot = me.ok ? '@' + me.result.username : 'XATO: ' + tgError(me) + ' ' + (me.description || '');
  if (me.ok && chat) {
    const ch = await tg('getChat', { chat_id: chat });
    out.group = ch.ok ? ch.result.title : 'XATO: ' + (ch.description || ch.error_code) + ' (bot guruhga qo\'shilmagan bo\'lishi mumkin)';
    if (ch.ok) {
      const m = await tg('getChatMember', { chat_id: chat, user_id: me.result.id });
      out.bot_in_group = m.ok ? m.result.status : 'XATO: ' + (m.description || m.error_code);
    }
  }
  out.tayyor = !!(me.ok && out.bot_in_group && !String(out.bot_in_group).startsWith('XATO') && out.bot_in_group !== 'left' && out.bot_in_group !== 'kicked');
  return out;
}

export default async function handler(req) {
  const url = new URL(req.url);
  if (req.method === 'GET' && url.searchParams.has('check')) return json(await check());

  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);
  if (!envToken() || !envChat()) return json({ ok: false, error: 'env' }, 500);
  if (!originAllowed(req)) return json({ ok: false, error: 'origin' }, 403);

  let b = {};
  try { b = await req.json(); } catch (e) { b = {}; }

  // Botlar: javob "ok", lekin hech narsa yuborilmaydi
  if (clean(b.website, 200)) return json({ ok: true });
  if (!(Number(b.t) >= MIN_FILL_MS)) return json({ ok: true });

  const name = clean(b.name, 60);
  const phone = String(b.phone || '').replace(/\D/g, '').replace(/^998(?=\d{9}$)/, '');
  const detail = clean(b.detail, 200);
  const whom = clean(b.whom, 100);
  if (!name || !PHONE_RE.test(phone) || /^(\d)\1{8}$/.test(phone) || !detail || !whom) {
    return json({ ok: false, error: 'input' }, 400);
  }

  const now = Date.now();
  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
  if (tooMany(ip, now)) return json({ ok: false, error: 'limit' }, 429);

  const last = sentPhones.get(phone);
  if (last && now - last < WINDOW_MS) return json({ ok: true, dup: true });

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
    sentPhones.set(phone, Date.now());      // faqat muvaffaqiyatli yuborilgandan keyin
    return json({ ok: true });
  }
  console.error('telegram sendMessage failed:', r.error_code, r.description);
  return json({ ok: false, error: tgError(r) }, 502);
}
