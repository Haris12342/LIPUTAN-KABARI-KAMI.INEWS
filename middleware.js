/**
 * ============================================================================
 * middleware.js — LIPUTAN KABAR NUSANTARA (Vercel Edge Middleware, ROOT)
 * ============================================================================
 *
 * TUGAS FILE INI (pengganti worker.js & api/share.js — website di-host Vercel):
 * Menyajikan halaman website seperti biasa, TAPI menambahkan meta Open Graph
 * + Twitter Card + canonical yang SESUAI dengan artikel yang dibagikan,
 * langsung di sisi server — sehingga foto & judul berita SELALU tampil di
 * pratinjau WhatsApp, Facebook, Telegram, X/Twitter, dst.
 *
 * KENAPA NAMANYA middleware.js DAN KENAPA DI ROOT?
 * Vercel HANYA menjalankan kode server dari (a) folder "api/" atau
 * (b) file bernama persis "middleware.js" di root repo. File "share.js"
 * di root TIDAK pernah dijalankan Vercel — itu sebabnya link share sempat
 * 404. middleware.js dipilih supaya tata letak repo tetap DATAR: semua file
 * di root, tidak perlu membuat folder apa pun.
 *
 * Kenapa perlu fungsi ini? Bot media sosial TIDAK menjalankan JavaScript.
 * Website ini aplikasi satu halaman (React), jadi tanpa fungsi ini semua
 * link berbagi hanya memakai meta default (logo), bukan foto artikelnya.
 *
 * CARA KERJA:
 * 1. Vercel otomatis memanggil file ini untuk rute "/", "/b/<slug>" dan
 *    "/berita/<slug>" (daftar rute ada di config.matcher di bawah).
 *    Tidak perlu vercel.json, tidak perlu folder api/.
 * 2. Fungsi mengambil index.html TERBARU dari deployment (jadi begitu Anda
 *    menambah berita lewat GitHub, fungsi otomatis ikut mengenalinya —
 *    tidak perlu set ulang apa pun).
 * 3. Blok window.BERITA_DATA dibaca dari index.html, artikel dicocokkan
 *    dari slug di URL, lalu meta tag disuntikkan sebelum HTML dikirim.
 * 4. URL foto dibersihkan otomatis dari karakter tak terlihat (sering ikut
 *    ter-copy dari WhatsApp/chat) dan dialirkan lewat proxy kompresi
 *    wsrv.nl menjadi JPEG 1200x630 (±100-250 KB) — di bawah batas unduhan
 *    bot WhatsApp (±600 KB) sehingga foto SELALU mampu tampil.
 * 5. Jika ada kesalahan apa pun, pengunjung tetap diarahkan ke halaman
 *    website normal — tidak pernah error kosong.
 * ============================================================================
 */

/* ============================== IDENTITAS SITUS ============================ */
const SITE_NAME = 'LIPUTAN KABAR NUSANTARA';
const SITE_TITLE_HOME = SITE_NAME + ' - Portal Berita Nasional';
const SITE_DESC = SITE_NAME + ' - Portal berita Indonesia dengan liputan terkini dari 38 provinsi.';
const SITE_AUTHOR = 'Redaksi ' + SITE_NAME + '.INEWS';
const FALLBACK_IMAGE = '/logo-liputan-kabar-nusantara.png';

/* ============== PROXY KOMPRESI GAMBAR (wsrv.nl / images.weserv.nl) ========= */
const IMG_PROXY = 'https://wsrv.nl/';
const OG_W = 1200;
const OG_H = 630;
/* Dimensi logo situs (fallback) — logo dikirim langsung tanpa proxy */
const LOGO_W = 1200;
const LOGO_H = 630;

/* ============ DAFTAR FEED — SAMA PERSIS DENGAN index.html (REAL_NEWS_FEEDS) = */
const REAL_NEWS_FEEDS = [
  { url: 'https://www.antaranews.com/rss/news.xml', name: 'ANTARA News' },
  { url: 'https://rss.detik.com/index.php/detikcom', name: 'Detik.com' },
  { url: 'https://www.cnnindonesia.com/rss', name: 'CNN Indonesia' },
  { url: 'https://www.liputan6.com/rss/feed/terkini', name: 'Liputan6' },
  { url: 'https://www.kompas.com/navsource/rss/0', name: 'Kompas.com' },
  { url: 'https://feeds.bbci.co.uk/indonesian/rss.xml', name: 'BBC Indonesia' },
  { url: 'https://rss.tempo.co/nasional', name: 'Tempo' },
  { url: 'https://www.tribunnews.com/rss', name: 'Tribunnews' },
  { url: 'https://news.okezone.com/allrss', name: 'Okezone' },
  { url: 'https://www.jpnn.com/rss', name: 'JPNN' },
  { url: 'https://news.google.com/rss?hl=id&gl=ID&ceid=ID:id', name: 'Google News' },
  { url: 'https://www.tangerangnews.com/rss', name: 'TangerangNews' }
];
const RSS2JSON = 'https://api.rss2json.com/v1/api.json?rss_url=';
const FEED_TIMEOUT_MS = 9000;
const FEED_TTL_MS = 5 * 60 * 1000;
const FEED_FAIL_TTL_MS = 2 * 60 * 1000;
const META_TTL_MS = 10 * 60 * 1000;
const META_NEG_TTL_MS = 60 * 1000;
const DESC_MAX = 220;

/* ============================== CACHE MODULE =============================== */
const beritaCache = { fp: '', articles: null };
const feedCache = new Map();
const rssMetaCache = new Map();

/* ========================= UTIL DASAR (parity dgn app) ===================== */
function hashStr(s) {
  let h = 0; const t = String(s);
  for (let i = 0; i < t.length; i++) { h = (h * 31 + t.charCodeAt(i)) >>> 0; }
  return h;
}
function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}
function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ============ PEMBERSIH URL FOTO (karakter tak terlihat dsb.) ============== */
/* URL yang di-copy dari WhatsApp/chat sering membawa karakter tak terlihat
   (word-joiner U+2060, zero-width space, dsb.) yang membuat URL menjadi
   404 — foto tak pernah bisa tampil. Semua dibersihkan di sini secara
   otomatis, jadi URL "sedikit kotor" dari HP tetap berfungsi.               */
function sanitizeFotoUrl(raw) {
  let s = String(raw || '');
  /* karakter tak terlihat literal */
  s = s.replace(/[\u200B-\u200F\u2060-\u2064\uFEFF\u00AD\u180E\u202A-\u202E\u2066-\u206F]/g, '');
  /* bentuk yang sudah ter-encode di dalam URL */
  s = s.replace(/%E2%80%8B|%E2%80%8C|%E2%80%8D|%E2%81%A0|%EF%BB%BF|%C2%AD|%E2%80%AE/gi, '');
  /* spasi valid dalam path jadi %20 (bukan dihapus), sisanya di-trim */
  s = s.trim().replace(/[\t\r\n]+/g, '').replace(/ +/g, '%20');
  return s;
}

/* ============ KONVERSI URL HALAMAN GITHUB -> URL GAMBAR MENTAH ============= */
/* Sering terjadi: kolom foto diisi alamat HALAMAN GitHub (github.com/<user>/
   <repo>/blob/... atau /raw/...) alih-alih file mentahnya. Halaman itu berisi
   HTML, bukan gambar, jadi foto tidak akan pernah tampil di pratinjau.
   Di sini alamat tersebut dikonversi OTOMATIS ke raw.githubusercontent.com. */
function rawkanGithubUrl(u) {
  const s = String(u || '');
  let m = s.match(/^https?:\/\/(?:www\.)?github\.com\/([^\/]+)\/([^\/]+)\/blob\/(.+)$/i);
  if (m) return 'https://raw.githubusercontent.com/' + m[1] + '/' + m[2] + '/' + m[3];
  m = s.match(/^https?:\/\/(?:www\.)?github\.com\/([^\/]+)\/([^\/]+)\/raw\/(.+)$/i);
  if (m) return 'https://raw.githubusercontent.com/' + m[1] + '/' + m[2] + '/' + m[3];
  return s;
}

/* ===================== PARSING window.BERITA_DATA (toleran) ================ */
function extractArticles(html) {
  const fp = html.length + ':' + hashStr(html.slice(0, 1500)) + ':' + hashStr(html.slice(-1500));
  if (beritaCache.articles && beritaCache.fp === fp) return beritaCache.articles;
  let articles = [];
  try {
    const sm = html.match(/<script[^>]*id=["']berita-data-src["'][^>]*>([\s\S]*?)<\/script>/i);
    if (sm) {
      const am = sm[1].match(/BERITA_DATA\s*=\s*([\s\S]*?);?\s*window\.BERITA_DATA_OK/);
      const arr = am ? am[1] : sm[1];
      const start = arr.indexOf('[');
      const end = arr.lastIndexOf(']');
      if (start >= 0 && end > start) {
        articles = parseBeritaRecords(arr.slice(start + 1, end));
      }
    }
  } catch (e) { articles = []; }
  beritaCache.fp = fp;
  beritaCache.articles = articles;
  return articles;
}

function parseBeritaRecords(src) {
  const out = [];
  let depth = 0, inStr = null, esc = false, start = -1;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth++; continue; }
    if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        const a = recordToArticle(src.slice(start, i + 1), out.length);
        if (a) out.push(a);
        start = -1;
      }
      continue;
    }
  }
  return out;
}

function recordToArticle(rec, idx) {
  try {
    const judul = grabField(rec, 'judul');
    if (!judul) return null;
    return {
      id: 'seed-' + (idx + 1),
      title: judul,
      slug: slugify(judul),
      tanggal: grabField(rec, 'tanggal'),
      kategori: grabField(rec, 'kategori'),
      foto: grabField(rec, 'foto'),
      isi: grabField(rec, 'isi')
    };
  } catch (e) { return null; }
}

function grabField(rec, key) {
  try {
    const re = new RegExp('[{,\\s]' + key + '\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'|`[^`]*`)', 's');
    const m = rec.match(re);
    if (!m) return '';
    const raw = m[1];
    if (raw.charAt(0) === '`') return raw.slice(1, -1);
    try { return JSON.parse(raw); } catch (e) { /* bukan JSON valid */ }
    return raw.slice(1, -1);
  } catch (e) { return ''; }
}

function findSeed(key, articles) {
  const k = String(key || '').toLowerCase();
  for (let i = 0; i < articles.length; i++) {
    const a = articles[i];
    if (a.slug === k || a.id === k) return a;
  }
  return null;
}

/* ============================== META BUILDER =============================== */
function escAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function tag(kind, name, value) {
  return '<meta ' + kind + '="' + name + '" content="' + escAttr(value) + '"/>';
}

function buildDescription(text, fallback) {
  let t = stripHtml(text);
  if (!t) t = stripHtml(fallback);
  if (!t) return SITE_DESC;
  t = t.replace(/\s+/g, ' ').trim();
  if (t.length <= DESC_MAX) return t;
  const cut = t.slice(0, DESC_MAX);
  const dot = cut.lastIndexOf('. ');
  if (dot > 60) return cut.slice(0, dot + 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > 60 ? cut.slice(0, sp) : cut) + '…';
}

const BULAN_INDO = { januari: 0, februari: 1, maret: 2, april: 3, mei: 4, juni: 5, juli: 6, agustus: 7, september: 8, oktober: 9, november: 10, desember: 11 };
function isoTanggal(str) {
  let s = String(str || '').trim();
  if (!s) return '';
  s = s.replace(/^[A-Za-z]+,\s*/, '').replace(/\.$/, '').trim();
  const m = s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (m) {
    const bulan = BULAN_INDO[m[2].toLowerCase()];
    if (bulan !== undefined) {
      const d = new Date(Date.UTC(Number(m[3]), bulan, Number(m[1])));
      if (!isNaN(d)) return d.toISOString();
    }
  }
  const d = new Date(s);
  return isNaN(d) ? '' : d.toISOString();
}
function isoDate(d) { return (d && !isNaN(d)) ? d.toISOString() : ''; }

function proxify(absUrl) {
  return IMG_PROXY + '?url=' + encodeURIComponent(absUrl)
    + '&w=' + OG_W + '&h=' + OG_H + '&fit=cover&output=jpg&q=82';
}

function resolveImage(foto, origin) {
  const s0 = rawkanGithubUrl(sanitizeFotoUrl(foto));
  /* Foto base64 (data:image/...) tidak bisa dibaca bot medsos langsung dari
     HTML — disajikan lewat mode ?img= middleware ini (lihat prosesMiddleware). */
  if (/^data:image\//i.test(s0)) {
    return { embedded: true, uri: s0, url: '' };
  }
  const s = s0;
  if (!s) return origin + FALLBACK_IMAGE;
  let abs;
  if (/^https?:\/\//i.test(s)) abs = s;
  else if (s.indexOf('/') === 0) abs = origin + s;
  else if (s.indexOf('./') === 0) abs = origin + s.slice(1);
  else abs = origin + '/' + s.replace(/ /g, '%20');
  return proxify(abs);
}

function seedMeta(a, origin) {
  const slug = a.slug || a.id;
  const img = resolveImage(a.foto, origin);
  const embedded = img && typeof img === 'object' && img.embedded;
  return {
    title: a.title,
    description: buildDescription(a.isi || '', a.title),
    image: embedded ? origin + '/?img=' + encodeURIComponent(slug) : img,
    imageW: embedded ? '' : OG_W,
    imageH: embedded ? '' : OG_H,
    imageType: embedded ? (String(a.foto).match(/^data:(image\/[a-z0-9.+-]+)/i) || ['', 'image/jpeg'])[1] : 'image/jpeg',
    imageAlt: a.title,
    url: origin + '/b/' + encodeURIComponent(slug),
    type: 'article',
    publishedTime: isoTanggal(a.tanggal),
    author: SITE_AUTHOR
  };
}

function defaultMeta(origin) {
  return {
    title: SITE_NAME,
    description: SITE_DESC,
    image: origin + FALLBACK_IMAGE,
    imageW: LOGO_W,
    imageH: LOGO_H,
    imageType: 'image/png',
    imageAlt: SITE_NAME,
    url: origin + '/',
    type: 'website',
    publishedTime: '',
    author: ''
  };
}

/* ==================== RESOLUSI ARTIKEL DARI FEED (RSS) ===================== */
function extractImage(item) {
  if (!item) return '';
  if (item.thumbnail) return String(item.thumbnail);
  if (item.enclosure && item.enclosure.link && /\.(jpg|jpeg|png|webp|gif)/i.test(item.enclosure.link)) return String(item.enclosure.link);
  const html = (item.content || '') + ' ' + (item.description || '');
  const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (m && m[1].indexOf('news.google.com') === -1) return m[1];
  const m2 = html.match(/https?:\/\/[^\s"'<>]+\.(?:jpg|jpeg|png|webp)/i);
  if (m2 && m2[0].indexOf('news.google.com') === -1) return m2[0];
  return '';
}

function withTimeout(p, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(undefined), ms);
    Promise.resolve(p).then(
      (v) => { clearTimeout(t); resolve(v); },
      () => { clearTimeout(t); resolve(undefined); }
    );
  });
}

async function getAllFeedItems() {
  const now = Date.now();
  const lists = await Promise.all(REAL_NEWS_FEEDS.map(async (feed) => {
    const c = feedCache.get(feed.url);
    if (c && c.exp > now) return c.items;
    try {
      const res = await withTimeout(
        fetch(RSS2JSON + encodeURIComponent(feed.url), { headers: { accept: 'application/json' } }),
        FEED_TIMEOUT_MS
      );
      const data = res ? await res.json() : null;
      const items = (data && data.status === 'ok' && Array.isArray(data.items)) ? data.items : [];
      feedCache.set(feed.url, { items, exp: Date.now() + (items.length ? FEED_TTL_MS : FEED_FAIL_TTL_MS) });
      return items;
    } catch (e) {
      feedCache.set(feed.url, { items: [], exp: Date.now() + FEED_FAIL_TTL_MS });
      return [];
    }
  }));
  return lists.flat();
}

async function resolveRssMeta(key, origin) {
  const now = Date.now();
  const hit = rssMetaCache.get(key);
  if (hit && hit.exp > now) return hit.meta;
  let meta = null;
  try {
    const items = await getAllFeedItems();
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it) continue;
      const id = 'real-' + hashStr(it.guid || it.link || it.title || '');
      const slug = slugify(it.title || '');
      if (id === key || (slug && slug === key)) {
        const title = stripHtml(it.title || '');
        const img = extractImage(it);
        meta = {
          title,
          description: buildDescription(stripHtml(it.content || '') + ' ' + stripHtml(it.description || ''), title),
          image: /^https?:\/\//i.test(sanitizeFotoUrl(img || '')) ? proxify(sanitizeFotoUrl(img)) : origin + FALLBACK_IMAGE,
          imageW: OG_W,
          imageH: OG_H,
          imageType: 'image/jpeg',
          imageAlt: title,
          url: origin + '/b/' + encodeURIComponent(key),
          type: 'article',
          publishedTime: isoDate(it.pubDate ? new Date(it.pubDate) : null),
          author: it.author ? stripHtml(String(it.author)).slice(0, 80) : ''
        };
        break;
      }
    }
  } catch (e) { meta = null; }
  try { rssMetaCache.set(key, { meta, exp: now + (meta ? META_TTL_MS : META_NEG_TTL_MS) }); } catch (e) {}
  return meta;
}

/* ===================== INJEKSI META KE HTML (server-side) ================== */
function metaBlock(m) {
  const parts = [];
  parts.push(tag('property', 'og:title', m.title));
  parts.push(tag('property', 'og:description', m.description));
  parts.push(tag('property', 'og:image', m.image));
  if (m.imageW && m.imageH) {
    parts.push(tag('property', 'og:image:width', String(m.imageW)));
    parts.push(tag('property', 'og:image:height', String(m.imageH)));
  }
  if (m.imageType) parts.push(tag('property', 'og:image:type', m.imageType));
  parts.push(tag('property', 'og:image:alt', m.imageAlt || m.title));
  parts.push(tag('property', 'og:url', m.url));
  parts.push(tag('property', 'og:type', m.type || 'article'));
  parts.push(tag('property', 'og:site_name', SITE_NAME));
  parts.push(tag('property', 'og:locale', 'id_ID'));
  if (m.publishedTime) {
    parts.push(tag('property', 'article:published_time', m.publishedTime));
    parts.push(tag('property', 'article:author', m.author || SITE_AUTHOR));
  }
  parts.push('<meta name="twitter:card" content="summary_large_image"/>');
  parts.push(tag('name', 'twitter:title', m.title));
  parts.push(tag('name', 'twitter:description', m.description));
  parts.push(tag('name', 'twitter:image', m.image));
  parts.push('<link rel="canonical" href="' + escAttr(m.url) + '"/>');
  parts.push(tag('name', 'description', m.description));
  return '\n<!-- ===== OPEN GRAPH / TWITTER CARD: dibuat otomatis oleh middleware.js sesuai artikel ===== -->\n'
    + parts.join('\n') + '\n';
}

function injectMeta(html, meta) {
  const fullTitle = (meta.type === 'article')
    ? (meta.title + ' - ' + SITE_NAME)
    : SITE_TITLE_HOME;
  let out = html
    .replace(/<meta[^>]+property=["']og:[^>]*>/gi, '')
    .replace(/<meta[^>]+property=["']article:[^>]*>/gi, '')
    .replace(/<meta[^>]+name=["']twitter:[^>]*>/gi, '')
    .replace(/<meta[^>]+name=["']description["'][^>]*>/gi, '')
    .replace(/<link[^>]+rel=["']canonical["'][^>]*>/gi, '')
    .replace(/<title>[\s\S]*?<\/title>/i, () => '<title>' + escAttr(fullTitle) + '</title>');
  const block = metaBlock(meta);
  if (/<\/head>/i.test(out)) out = out.replace(/<\/head>/i, () => block + '</head>');
  else out = block + out;
  return out;
}

async function resolveMeta(key, articles, origin) {
  const k = String(key || '').trim().toLowerCase();
  if (k) {
    const seed = findSeed(k, articles);
    if (seed) return seedMeta(seed, origin);
    const rss = await resolveRssMeta(k, origin);
    if (rss) return rss;
  }
  return defaultMeta(origin);
}

/* ============================ HANDLER (MIDDLEWARE) ========================= */
/* Vercel Edge Middleware — berjalan dari ROOT repo, TANPA folder api/, TANPA
   vercel.json. Vercel otomatis menjalankan file bernama "middleware.js" untuk
   rute yang terdaftar di config.matcher (lihat bawah): "/", "/b/<slug>",
   "/berita/<slug>". File statis (foto, favicon, logo, worker.js lama) tidak
   disentuh. Pengunjung & bot sama-sama menerima HTML yang sudah diberi meta
   artikel; pengunjung tetap membuka artikel lewat #slug.                     */

function ambilKunciArtikel(url) {
  /* Slug dicari dari TIGA sumber sekaligus supaya selalu ditemukan:
     1. ?berita= — dipakai link format lama (?berita=slug&v=3).
     2. ?slug=   — cadangan (varian routing lain kadang menyisipkan param ini).
     3. path /b/<slug> atau /berita/<slug> — link share tombol website.       */
  let key = url.searchParams.get('berita') || url.searchParams.get('slug') || '';
  if (!key) {
    const pm = url.pathname.match(/^\/(?:b|berita)\/(.+)$/i);
    if (pm) { try { key = decodeURIComponent(pm[1]); } catch (e) { key = pm[1]; } }
  }
  return key;
}

/* ================= FOTO EMBEDDED (base64) — jaring pengaman =================
   Kalau kolom foto diisi data base64 (data:image/...;base64,....), bot medsos
   tidak bisa mengambilnya. Mode ?img=<slug> menyajikan byte gambarnya langsung
   dari middleware ini, sehingga og:image tetap menunjuk URL yang VALID.      */
function dataUriKeResponse(uri) {
  const m = /^data:(image\/[a-z0-9.+-]+)\s*;\s*base64,([\s\S]+)$/i.exec(String(uri || '').trim());
  if (!m) return null;
  let bytes;
  try {
    const bin = atob(m[2].trim());
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch (e) { return null; }
  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': m[1].toLowerCase(),
      'cache-control': 'public, max-age=86400',
      'access-control-allow-origin': '*'
    }
  });
}

async function layaniFotoEmbedded(key, origin) {
  try {
    const assetRes = await fetch(new URL('/index.html', origin));
    const html = await assetRes.text();
    if (!html || html.length < 500) return null;
    const a = findSeed(String(key).trim().toLowerCase(), extractArticles(html));
    if (!a) return null;
    const s = rawkanGithubUrl(sanitizeFotoUrl(a.foto));
    if (!/^data:image\//i.test(s)) return null;
    return dataUriKeResponse(s);
  } catch (e) { return null; }
}

async function bangunHtml(html, url) {
  const articles = extractArticles(html);
  const key = ambilKunciArtikel(url);
  const meta = await resolveMeta(key, articles, url.origin);
  return injectMeta(html, meta);
}

/* Hanya halaman HTML yang diproses; file statis lewat tanpa disentuh.
   Catatan penting: /index.html sengaja TIDAK dihitung halaman proses —
   itu kunci agar pengambilan HTML di bawah tidak pernah berputar (loop).   */
function isPageUrl(url) {
  if (url.pathname === '/') return true;
  return /^\/(?:b|berita)\/.+/i.test(url.pathname);
}

async function prosesMiddleware(request) {
  const url = new URL(request.url);
  /* Mode ?img=<slug>: kirim byte foto embedded (base64) langsung */
  const imgKey = url.searchParams.get('img');
  if (imgKey && (request.method === 'GET' || request.method === 'HEAD')) {
    const imgRes = await layaniFotoEmbedded(imgKey, url.origin);
    if (imgRes) return imgRes;
    return Response.redirect(url.origin + '/logo-liputan-kabar-nusantara.png', 302);
  }
  if ((request.method !== 'GET' && request.method !== 'HEAD') || !isPageUrl(url)) {
    return fetch(request);
  }
  try {
    /* Ambil index.html TERBARU dari deployment ini — berita baru yang Anda
       tambahkan lewat GitHub otomatis langsung dikenali, tanpa set ulang.   */
    const assetRes = await fetch(new URL('/index.html', url.origin));
    const html = await assetRes.text();
    if (!html || html.length < 500) throw new Error('index.html kosong');
    const out = await bangunHtml(html, url);
    return new Response(request.method === 'HEAD' ? null : out, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=0, must-revalidate'
      }
    });
  } catch (e) {
    /* Apa pun yang terjadi: lempar pengunjung/bot ke halaman statis asli */
    try {
      return Response.redirect(url.origin + '/index.html', 302);
    } catch (e2) {
      return new Response('Service Unavailable', { status: 503 });
    }
  }
}

/* Vercel menjalankan default export dari middleware.js (semua framework) */
export default prosesMiddleware;
/* Nama ekspor "middleware" = konvensi yang sama dengan Next.js (kompatibel) */
export const middleware = prosesMiddleware;

/* Rute yang diproses middleware. PENTING: "/index.html" TIDAK ada di daftar
   ini, jadi pengambilan HTML dari deployment tidak pernah memicu middleware
   lagi (bebas loop). File statis juga tidak kena daftar ini.                 */
export const config = { matcher: ['/', '/b/:path*', '/berita/:path*'] };

/* Diekspor khusus untuk pengujian lokal (Node). Tidak memengaruhi produksi.  */
export const _internals = {
  hashStr, slugify, stripHtml, sanitizeFotoUrl, rawkanGithubUrl, extractArticles, parseBeritaRecords,
  grabField, findSeed, buildDescription, isoTanggal, resolveImage, proxify,
  injectMeta, metaBlock, extractImage, resolveMeta, seedMeta, defaultMeta,
  ambilKunciArtikel, bangunHtml, isPageUrl, dataUriKeResponse, layaniFotoEmbedded,
  _resetCaches() {
    beritaCache.fp = ''; beritaCache.articles = null;
    feedCache.clear(); rssMetaCache.clear();
  }
};
