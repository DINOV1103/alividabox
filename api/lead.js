// Alivida Organic — arizani Telegram'ga SERVER orqali yuborish (Vercel EDGE funksiyasi).
// Edge tarmog'i oddiy serverless funksiyalardan boshqa IP'lardan chiqadi — Telegram'ga ulanish shu orqali.
//
// Bot tokeni sahifa kodida yo'q, faqat Vercel sozlamalarida turadi:
//   Vercel → Settings → Environment Variables
//     TG_BOT_TOKEN   = bot tokeni
//     TG_CHAT_ID     = -1003837735629   ("A LEAD" guruhi)
//   Ixtiyoriy:
//     ALLOWED_ORIGINS = https://alividabox.vercel.app,https://alivida.uz   (vergul bilan)
//
// Tekshirish: brauzerda  /api/lead?check=1  ni oching (token ko'rsatilmaydi).
//
// Spamga qarshi: boshqa saytlardan kelgan so'rov rad etiladi, yashirin "tuzoq" maydon,
// juda tez yuborilgan forma, noto'g'ri raqam, bir IP'dan ko'p ariza va bir xil raqamni
// qayta-qayta yuborish to'xtatiladi.

export const config = { runtime: 'edge' };

const PHONE_RE = /^(20|33|50|55|77|88|90|91|93|94|95|97|98|99|6[1-9]|7[0-9])\d{7}$/;
const MIN_FILL_MS = 3000;
const IP_LIMIT = 10;                 // bitta IP'dan 10 daqiqada ko'pi bilan 10 ariza
const WINDOW_MS = 10 * 60 * 1000;
const TG_TIMEOUT_MS = 8000;

const byIp = new Map();
const sentPhones = new Map();

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clean = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
const envToken = () => String(process.env.TG_BOT_TOKEN || '').trim();
const envChat = () => String(process.env.TG_CHAT_ID || '').trim();

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

async function timed(url, init, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const t0 = Date.now();
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal });
    return { r, ms: Date.now() - t0 };
  } catch (e) {
    return { err: e.name === 'AbortError' ? 'timeout' : 'network: ' + e.message, ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

let lastVia = '';
async function tg(method, payload) {
  const x = await timed(`https://api.telegram.org/bot${envToken()}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
  }, TG_TIMEOUT_MS);
  lastVia = 'edge fetch ' + x.ms + 'ms';
  if (x.err) return { ok: false, error_code: 0, description: x.err };
  return x.r.json().catch(() => ({ ok: false, error_code: x.r.status, description: 'bad response' }));
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
  return list.length > IP_LIMIT;
}

export default async function handler(req) {
  const url = new URL(req.url);

  // --- tekshiruv: /api/lead?check=1 ---
  if (req.method === 'GET' && url.searchParams.has('check')) {
    const out = {
      runtime: 'edge',
      region: process.env.VERCEL_REGION || 'unknown',
      token_set: !!envToken(), chat_set: !!envChat(), chat_id: envChat() || null,
    };
    const g = await timed('https://www.google.com/generate_204', {}, 5000);
    out.internet = g.err ? 'XATO: ' + g.err : 'ok ' + g.ms + 'ms';
    const t = await timed('https://api.telegram.org/', {}, 8000);
    out.telegram_reach = t.err ? 'XATO: ' + t.err + ' (' + t.ms + 'ms)' : 'ok ' + t.ms + 'ms';
    if (out.token_set && !t.err) {
      const me = await tg('getMe');
      out.bot = me.ok ? '@' + me.result.username : 'XATO: ' + (me.description || me.error_code);
      if (me.ok && out.chat_set) {
        const ch = await tg('getChat', { chat_id: envChat() });
        out.group = ch.ok ? ch.result.title : 'XATO: ' + (ch.description || ch.error_code);
        if (ch.ok) {
          const mem = await tg('getChatMember', { chat_id: envChat(), user_id: me.result.id });
          out.bot_in_group = mem.ok ? mem.result.status : 'XATO: ' + (mem.description || mem.error_code);
        }
      }
    }
    return json(out);
  }

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

  if (name.length < 2 || !PHONE_RE.test(phone) || /^(\d)\1+$/.test(phone.slice(2)) || !detail || !whom) {
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
    sentPhones.set(phone, Date.now());
    return json({ ok: true });
  }
  console.error('telegram sendMessage failed:', r.error_code, r.description, lastVia);
  return json({ ok: false, error: 'tg_' + (r.error_code || (r.description === 'timeout' ? 'timeout' : 'net')) }, 502);
}
