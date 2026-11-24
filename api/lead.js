// Alivida Organic — ZAXIRA yo'l: sahifa Apps Script'ga yubora olmasa, ariza shu yerga keladi (Vercel EDGE funksiyasi).
// Bu funksiya bir vaqtda ikkita ishni qiladi:
//   1) arizani Telegram guruhiga yuboradi;
//   2) arizani Apps Script orqali Google Sheets'ga yozdiradi (tg_skip — Telegram'ni Apps Script qayta yubormaydi).
// Ikkalasidan bittasi o'xshasa — ariza qabul qilingan hisoblanadi (lead yo'qolmaydi).
//
// Bot tokeni sahifa kodida ham, GitHub'da ham YO'Q — faqat Vercel sozlamalarida turadi:
//   Vercel → Settings → Environment Variables
//     TG_BOT_TOKEN   = BotFather bergan token
//     TG_CHAT_ID     = guruh ID'si
//   Ixtiyoriy:
//     CHECK_KEY       = to'liq tekshiruv uchun maxfiy so'z (masalan: alivida2026)
//     GAS_URL         = Apps Script /exec manzili (standart qiymat pastda)
//     ALLOWED_ORIGINS = https://alividabox.vercel.app,https://alivida.uz   (vergul bilan)
//   MUHIM: o'zgaruvchini almashtirgandan keyin Deployments → ... → Redeploy qiling,
//   aks holda sayt eski token bilan ishlayveradi.
//
// Tekshirish:  /api/lead?check=1            — umumiy holat (botga murojaat qilmaydi)
//              /api/lead?check=CHECK_KEY    — bot va guruhni ham tekshiradi
//
// Spamga qarshi: boshqa saytlardan kelgan so'rov rad etiladi, yashirin "tuzoq" maydon,
// juda tez yuborilgan forma va noto'g'ri raqam to'xtatiladi.

export const config = { runtime: 'edge' };

const DEFAULT_GAS_URL = 'https://script.google.com/macros/s/AKfycbx2_7rgdJ4zkvMyO6ilMHMpGJxVxltp8LwNivegzGl02eG4E3zclMH3bYElRO_L9PA/exec';
const PHONE_RE = /^(20|33|50|55|77|88|90|91|93|94|95|97|98|99|6[1-9]|7[0-9])\d{7}$/;
const TOKEN_RE = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/;
const MIN_FILL_MS = 3000;
const IP_LIMIT = 10;                 // bitta IP'dan 10 daqiqada ko'pi bilan 10 ariza (bitta server nusxasi doirasida)
const WINDOW_MS = 10 * 60 * 1000;
const TG_TIMEOUT_MS = 8000;
const GAS_TIMEOUT_MS = 12000;

const byIp = new Map();
const sentPhones = new Map();

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clean = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
// Token ko'chirilganda tasodifan qo'shilgan qo'shtirnoq, bo'sh joy yoki "bot" so'zi olib tashlanadi
const envToken = () => String(process.env.TG_BOT_TOKEN || '').trim().replace(/^['"]|['"]$/g, '').replace(/^bot/, '').trim();
const envChat = () => String(process.env.TG_CHAT_ID || '').trim();
const gasUrl = () => String(process.env.GAS_URL || '').trim() || DEFAULT_GAS_URL;
const mask = (s) => (s ? '…' + String(s).slice(-4) : null);

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

async function tg(method, payload) {
  const x = await timed(`https://api.telegram.org/bot${envToken()}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
  }, TG_TIMEOUT_MS);
  if (x.err) return { ok: false, error_code: 0, description: x.err };
  return x.r.json().catch(() => ({ ok: false, error_code: x.r.status, description: 'bad response' }));
}

// Telegram xatosini qisqa kodga aylantiradi: tg_401, tg_429_32s, tg_timeout ...
function tgError(r) {
  if (!r) return 'tg_net';
  if (r.description === 'timeout') return 'tg_timeout';
  const wait = r.parameters && r.parameters.retry_after ? '_' + r.parameters.retry_after + 's' : '';
  return 'tg_' + (r.error_code || 'net') + wait;
}

async function saveToSheet(b) {
  const x = await timed(gasUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ ...b, tg_skip: true }),
    redirect: 'follow',
  }, GAS_TIMEOUT_MS);
  if (x.err) return { ok: false, error: 'sheet_' + (x.err === 'timeout' ? 'timeout' : 'net') };
  const j = await x.r.json().catch(() => null);
  if (j && j.ok) return { ok: true };
  return { ok: false, error: 'sheet_' + ((j && j.error) || x.r.status) };
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

async function check(url) {
  const token = envToken();
  const key = String(process.env.CHECK_KEY || '').trim();
  const full = !!key && url.searchParams.get('check') === key;
  const out = {
    runtime: 'edge',
    region: process.env.VERCEL_REGION || 'unknown',
    token_set: !!token,
    token_format: !token ? null : (TOKEN_RE.test(token) ? 'ok' : 'XATO: token noto\'g\'ri ko\'chirilgan'),
    chat_set: !!envChat(),
    chat_id: mask(envChat()),
  };
  const [g, t, s] = await Promise.all([
    timed('https://www.google.com/generate_204', {}, 5000),
    timed('https://api.telegram.org/', {}, 6000),
    timed(gasUrl(), { redirect: 'follow' }, 8000),
  ]);
  out.internet = g.err ? 'XATO: ' + g.err : 'ok ' + g.ms + 'ms';
  out.telegram_reach = t.err ? 'XATO: ' + t.err : 'ok ' + t.ms + 'ms';
  if (s.err) out.apps_script = 'XATO: ' + s.err;
  else {
    const j = await s.r.json().catch(() => null);
    out.apps_script = j && j.ok ? 'ok ' + s.ms + 'ms' : 'XATO: javob ' + s.r.status;
  }
  if (!full) {
    out.bot = key ? 'bot tekshiruvi uchun /api/lead?check=CHECK_KEY' : 'bot tekshiruvi uchun Vercel\'da CHECK_KEY qo\'ying';
    return json(out);
  }
  if (out.token_set && !t.err) {
    const me = await tg('getMe');
    out.bot = me.ok ? '@' + me.result.username : 'XATO: ' + (me.description || me.error_code) + ' (' + tgError(me) + ')';
    if (me.ok && out.chat_set) {
      const mem = await tg('getChatMember', { chat_id: envChat(), user_id: me.result.id });
      out.bot_in_group = mem.ok ? mem.result.status : 'XATO: ' + (mem.description || mem.error_code);
    }
  }
  return json(out);
}

export default async function handler(req) {
  const url = new URL(req.url);

  if (req.method === 'GET' && url.searchParams.has('check')) return check(url);

  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);
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
  const source = clean(b.source, 60) || 'Alivida Landing Page';

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
    '🌐 <b>Манба:</b> ' + esc(source);

  const lead = { name, phone, detail, whom, source, t: b.t, website: '' };
  const sendTg = envToken() && envChat()
    ? tg('sendMessage', { chat_id: envChat(), text, parse_mode: 'HTML', disable_web_page_preview: true })
    : Promise.resolve({ ok: false, error_code: 'env' });

  const [r, sheet] = await Promise.all([sendTg, saveToSheet(lead)]);

  if (r.ok) sentPhones.set(phone, Date.now());
  if (!r.ok) console.error('telegram sendMessage failed:', tgError(r), r.description || '');
  if (!sheet.ok) console.error('sheet save failed:', sheet.error);

  if (r.ok || sheet.ok) {
    return json({ ok: true, tg: !!r.ok, saved: !!sheet.ok, tg_error: r.ok ? undefined : tgError(r) });
  }
  return json({ ok: false, error: tgError(r) + ',' + sheet.error }, 502);
}
