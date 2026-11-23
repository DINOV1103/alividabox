// Alivida Organic — Meta Conversions API (server tomoni)
// Vercel bu faylni /api/capi manzilida ishga tushiradi.
// Token BU FAYLDA YO'Q: Vercel → Settings → Environment Variables → META_CAPI_TOKEN
// Ixtiyoriy: META_TEST_EVENT_CODE (Events Manager → Test events kodini tekshirish uchun)

const crypto = require('crypto');

const PIXEL_ID = process.env.META_PIXEL_ID || '2185905285373591';
const API_VERSION = 'v26.0';

const sha256 = (v) => crypto.createHash('sha256').update(String(v).trim().toLowerCase(), 'utf8').digest('hex');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'POST only' });
    return;
  }

  const token = process.env.META_CAPI_TOKEN;
  if (!token) {
    res.status(500).json({ ok: false, error: 'META_CAPI_TOKEN is not set' });
    return;
  }

  let body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }

  const phone = String(body.phone || '').replace(/\D/g, '');
  const eventId = String(body.event_id || '').slice(0, 100);
  if (!/^998\d{9}$/.test(phone) || !eventId) {
    res.status(400).json({ ok: false, error: 'bad input' });
    return;
  }

  const firstName = String(body.name || '').trim().split(/\s+/)[0] || '';
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ua = String(req.headers['user-agent'] || '');

  const userData = {
    ph: [sha256(phone)],
    country: [sha256('uz')],
  };
  if (firstName) userData.fn = [sha256(firstName)];
  if (ip) userData.client_ip_address = ip;
  if (ua) userData.client_user_agent = ua;
  if (body.fbp) userData.fbp = String(body.fbp).slice(0, 200);
  if (body.fbc) userData.fbc = String(body.fbc).slice(0, 500);

  const payload = {
    data: [{
      event_name: 'Lead',
      event_time: Math.floor(Date.now() / 1000),
      event_id: eventId,
      action_source: 'website',
      event_source_url: String(body.url || '').slice(0, 1000) || undefined,
      user_data: userData,
      custom_data: { content_name: 'Joint & Bone Complex' },
    }],
  };
  if (process.env.META_TEST_EVENT_CODE) payload.test_event_code = process.env.META_TEST_EVENT_CODE;

  try {
    const r = await fetch(
      `https://graph.facebook.com/${API_VERSION}/${PIXEL_ID}/events?access_token=${encodeURIComponent(token)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
    );
    const meta = await r.json().catch(() => ({}));
    res.status(r.ok ? 200 : 502).json({ ok: r.ok, meta });
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e) });
  }
};
