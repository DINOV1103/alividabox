// Alivida Organic — arizani brauzerdan to'g'ridan-to'g'ri Telegram'ga yuborish uchun bot sozlamasini beradi.
//
// Nega: Telegram Vercel va Google serverlaridan kelgan so'rovlarga 429 qaytaryapti, mijoz brauzeridan esa
// yuborish ishlaydi. Shuning uchun xabarni mijozning brauzeri yuboradi.
//
// Token sahifa kodida ham, GitHub'da ham YO'Q. U faqat Vercel sozlamalarida turadi:
//   Vercel → Settings → Environment Variables
//     TG_BOT_TOKEN = bot tokeni
//     TG_CHAT_ID   = guruh ID'si (-100... ko'rinishida)
// Tokenni almashtirish uchun kodga tegish shart emas: Vercel'da qiymatni o'zgartiring va Redeploy qiling.
//
// Token faqat shu holatda beriladi: so'rov shu saytning o'zidan kelgan, forma to'g'ri to'ldirilgan,
// yashirin "tuzoq" maydon bo'sh, forma 3 soniyadan sekinroq to'ldirilgan va bitta IP'dan ko'p so'rov yo'q.
// Javobda token ochiq ko'rinishda bo'lmaydi (har safar boshqa kalit bilan aralashtiriladi), shuning uchun
// sayt va GitHub'ni token qidirib skanerlaydigan botlar uni topa olmaydi.

export const config = { runtime: 'edge' };

const PHONE_RE = /^(20|33|50|55|77|88|90|91|93|94|95|97|98|99|6[1-9]|7[0-9])\d{7}$/;
const MIN_FILL_MS = 3000;
const IP_LIMIT = 10;                 // bitta IP'dan 10 daqiqada ko'pi bilan 10 ta
const WINDOW_MS = 10 * 60 * 1000;

const byIp = new Map();

const clean = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
const envToken = () => String(process.env.TG_BOT_TOKEN || '').trim();
const envChat = () => String(process.env.TG_CHAT_ID || '').trim();

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

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

const b64 = (bytes) => { let s = ''; for (const x of bytes) s += String.fromCharCode(x); return btoa(s); };

function pack(text) {
  const data = new TextEncoder().encode(text);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const out = data.map((x, i) => x ^ salt[i % salt.length] ^ ((i * 7) & 255));
  return { a: b64(out), b: b64(salt) };
}

export default async function handler(req) {
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);
  if (!envToken() || !envChat()) return json({ ok: false, error: 'env' }, 500);
  if (!originAllowed(req)) return json({ ok: false, error: 'origin' }, 403);

  let b = {};
  try { b = await req.json(); } catch (e) { b = {}; }

  // Botlar: javob "ok", lekin hech narsa berilmaydi
  if (clean(b.website, 200)) return json({ ok: true });
  if (!(Number(b.t) >= MIN_FILL_MS)) return json({ ok: true });

  const name = clean(b.name, 60);
  const phone = String(b.phone || '').replace(/\D/g, '').replace(/^998(?=\d{9}$)/, '');
  const detail = clean(b.detail, 200);
  const whom = clean(b.whom, 100);
  if (name.length < 2 || !PHONE_RE.test(phone) || /^(\d)\1+$/.test(phone.slice(2)) || !detail || !whom) {
    return json({ ok: false, error: 'input' }, 400);
  }

  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
  if (tooMany(ip, Date.now())) return json({ ok: false, error: 'limit' }, 429);

  return json({ ok: true, ...pack(envToken() + '\n' + envChat()) });
}
