/**
 * Alivida Organic — arizalarni qabul qiluvchi Google Apps Script (Sheets + Telegram).
 *
 * TARTIB: avval ariza Google Sheets'ga yoziladi (asosiy joy), keyin Telegram'ga yuboriladi.
 * Telegram ishlamasa ham ariza yo'qolmaydi: jadvalda qoladi, saytga "ok" qaytadi.
 *
 * O'RNATISH (bir marta):
 *  1. script.google.com → loyihangizni oching → Code.gs ichidagini butunlay shu fayl bilan almashtiring → Saqlash.
 *  2. Project Settings (tishli g'ildirak) → Script properties → qo'shing:
 *       TG_BOT_TOKEN = BotFather bergan YANGI token   (HTML'ga ham, GitHub'ga ham hech qachon yozilmaydi)
 *       TG_CHAT_ID   = guruh ID'si ("A LEAD" guruhi, -100 bilan boshlanadi)
 *     Ixtiyoriy:
 *       SHEET_ID     = jadval ID'si (skript jadvalning o'zidan ochilgan bo'lsa shart emas)
 *       SHEET_NAME   = varaq nomi (standart: "Arizalar" — yo'q bo'lsa o'zi yaratadi)
 *  3. Yuqoridan "tekshir" funksiyasini tanlab Run bosing → ruxsat bering. Guruhga test xabar kelishi kerak.
 *  4. Deploy → Manage deployments → qalamcha (Edit) → Version: "New version" → Deploy.
 *     Shunda /exec manzili O'ZGARMAYDI, saytda hech narsa almashtirish shart emas.
 *     Eslatma: kodni saqlashning o'zi yetmaydi — "New version" qilinmasa, sayt eski kod bilan ishlayveradi.
 *
 * Tokenni almashtirganda (revoke) faqat Script properties'dagi TG_BOT_TOKEN'ni yangilang —
 * bu darhol ishlaydi, qayta deploy shart emas.
 */

var PHONE_RE = /^(20|33|50|55|77|88|90|91|93|94|95|97|98|99|6[1-9]|7[0-9])\d{7}$/;
var MIN_FILL_MS = 3000;
var DUP_SECONDS = 600; // bir raqamdan 10 daqiqa ichida qayta kelgan ariza yozilmaydi
var HEADERS = ['Vaqt', 'Ism', 'Telefon', "Og'riq joyi", 'Kim uchun', 'Manba', 'Telegram'];

function doGet() {
  return out_({ ok: true, service: 'alivida-lead' });
}

function doPost(e) {
  var b = {};
  try { b = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { b = {}; }

  // Botlar: javob "ok", lekin hech narsa yozilmaydi
  if (clean_(b.website, 200)) return out_({ ok: true });
  if (!(Number(b.t) >= MIN_FILL_MS)) return out_({ ok: true });

  var name = clean_(b.name, 60);
  var phone = String(b.phone || '').replace(/\D/g, '').replace(/^998(?=\d{9}$)/, '');
  var detail = clean_(b.detail, 200);
  var whom = clean_(b.whom, 100);
  var source = clean_(b.source, 60) || 'Alivida Landing';
  if (name.length < 2 || !PHONE_RE.test(phone) || /^(\d)\1+$/.test(phone.slice(2)) || !detail || !whom) {
    return out_({ ok: false, error: 'input' });
  }

  var cache = CacheService.getScriptCache();
  var key = 'p' + phone;
  if (cache.get(key)) return out_({ ok: true, saved: true, dup: true });

  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (err) { return out_({ ok: false, error: 'busy' }); }

  var sheet, row, now = new Date();
  var pretty = '+998 ' + phone.replace(/^(\d{2})(\d{3})(\d{2})(\d{2})$/, '$1 $2 $3 $4');
  try {
    if (cache.get(key)) return out_({ ok: true, saved: true, dup: true });
    sheet = sheet_();
    sheet.appendRow([now, safe_(name), pretty, safe_(detail), safe_(whom), safe_(source), '...']);
    row = sheet.getLastRow();
    cache.put(key, '1', DUP_SECONDS);
  } catch (err) {
    return out_({ ok: false, error: 'sheet: ' + String(err && err.message || err).slice(0, 120) });
  } finally {
    lock.releaseLock();
  }

  // /api/lead (Vercel) Telegram'ni o'zi yuboradi va bu yerga faqat jadval uchun murojaat qiladi
  if (b.tg_skip) {
    setStatus_(sheet, row, 'Vercel orqali');
    return out_({ ok: true, saved: true });
  }

  var time = Utilities.formatDate(now, 'Asia/Tashkent', 'dd.MM.yyyy HH:mm:ss');
  var text =
    '🔵 <b>ЯНГИ БУЮРТМА (ALIVIDA ORGANIC)</b> 🔵\n\n' +
    '👤 <b>Исми:</b> ' + esc_(name) + '\n' +
    '📞 <b>Телефони:</b> ' + esc_(pretty) + '\n' +
    '🦴 <b>Оғриқ жойи:</b> ' + esc_(detail) + '\n' +
    '👥 <b>Ким учун:</b> ' + esc_(whom) + '\n' +
    '✅ <b>Розилик:</b> берилди\n' +
    '🕒 <b>Вақти:</b> ' + time + '\n' +
    '🌐 <b>Манба:</b> ' + esc_(source);

  var t = tg_(text);
  setStatus_(sheet, row, t.ok ? 'yuborildi' : 'XATO ' + t.error);
  return out_({ ok: true, saved: true, tg: t.ok, tg_error: t.ok ? undefined : t.error });
}

/* Qo'lda ishga tushirish uchun: jadval va Telegram ulanishini tekshiradi */
function tekshir() {
  var sh = sheet_();
  Logger.log('Jadval: ' + sh.getParent().getName() + ' / ' + sh.getName());
  Logger.log('Telegram: ' + JSON.stringify(tg_('✅ Alivida: test xabar (Apps Script)')));
}

function sheet_() {
  var p = PropertiesService.getScriptProperties();
  var id = String(p.getProperty('SHEET_ID') || '').trim();
  var ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('SHEET_ID kerak (Script properties)');
  var name = String(p.getProperty('SHEET_NAME') || '').trim() || 'Arizalar';
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(HEADERS);
    sh.setFrozenRows(1);
    sh.getRange('C:C').setNumberFormat('@');
  }
  return sh;
}

function tg_(text) {
  var p = PropertiesService.getScriptProperties();
  var token = String(p.getProperty('TG_BOT_TOKEN') || '').trim().replace(/^['"]|['"]$/g, '').replace(/^bot/, '');
  var chat = String(p.getProperty('TG_CHAT_ID') || '').trim();
  if (!token || !chat) return { ok: false, error: 'tg_env' };
  try {
    var r = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'post',
      contentType: 'application/json',
      muteHttpExceptions: true,
      payload: JSON.stringify({ chat_id: chat, text: text, parse_mode: 'HTML', disable_web_page_preview: true })
    });
    var j = {};
    try { j = JSON.parse(r.getContentText() || '{}'); } catch (err) { j = {}; }
    if (j.ok) return { ok: true };
    var code = j.error_code || r.getResponseCode();
    var wait = j.parameters && j.parameters.retry_after ? ' (' + j.parameters.retry_after + 's)' : '';
    return { ok: false, error: 'tg_' + code + wait };
  } catch (err) {
    return { ok: false, error: 'tg_net' };
  }
}

function setStatus_(sheet, row, value) {
  try { sheet.getRange(row, HEADERS.length).setValue(value); } catch (err) {}
}

function clean_(v, max) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
}

/* Jadvalda formula sifatida ishlab ketmasligi uchun (=, +, -, @ bilan boshlangan matn) */
function safe_(v) {
  v = String(v == null ? '' : v);
  return /^[=+\-@]/.test(v) ? "'" + v : v;
}

function esc_(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
