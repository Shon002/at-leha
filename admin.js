// Админка. Данные — data.json и photos/ в репозитории GitHub, запись через GitHub API.
// Ключ GitHub хранится в admin-key.json зашифрованным логином и паролем (PBKDF2 → AES-GCM).

// Админку нельзя открывать внутри чужого сайта (защита от кликджекинга).
if (window.top !== window.self) {
  document.documentElement.hidden = true;
  window.top.location = window.location.href;
}

const $ = (id) => document.getElementById(id);
const API = 'https://api.github.com';
const ITER = 600000;
const MIN_PASS = 10;
const SESSION_MS = 12 * 60 * 60 * 1000;
const REPO = window.SBOR_REPO || repoFromUrl(location.hostname, location.pathname);
const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

let token = null;
let keyBox = null;   // содержимое admin-key.json
let data = null;
let dataSha = null;
let dirty = false;
let editSeq = 0;     // растёт при каждой правке; правки во время сохранения не теряются
let busy = false;
let mePhotoFile = null;   // выбранное, ещё не загруженное фото «О себе»
let savedMePhoto = '';    // фото «О себе», которое сейчас в репозитории

// 'owner.github.io' + '/repo/admin.html' -> 'owner/repo'; корневой сайт ('/admin.html', '/admin') -> 'owner/owner.github.io'
function repoFromUrl(host, path) {
  if (!host.endsWith('.github.io')) return null;
  const parts = path.split('/').filter(Boolean);
  const project = parts.length > 1 || (parts.length === 1 && path.endsWith('/'));
  return host.split('.')[0] + '/' + (project ? parts[0] : host);
}

function show(id, on) { $(id).hidden = !on; }

function setMsg(el, text, kind) {
  el.textContent = text || '';
  el.className = 'msg' + (kind ? ' ' + kind : '');
}

// Вход помнится во вкладке 12 часов. Хранилище может быть недоступно — тогда просто не помним.
function readSession() {
  try {
    const s = JSON.parse(sessionStorage.getItem('sbor-session'));
    if (s && s.exp > Date.now()) return s.token;
    sessionStorage.removeItem('sbor-session');
  } catch { /* нет хранилища или мусор в нём */ }
  return null;
}

function saveSession() {
  try {
    sessionStorage.setItem('sbor-session', JSON.stringify({ token, exp: Date.now() + SESSION_MS }));
  } catch { /* не запоминаем */ }
}

function clearSession() {
  try { sessionStorage.removeItem('sbor-session'); } catch { /* нечего чистить */ }
}

// ---------- base64 ----------

function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function b64ToBytes(b64) {
  const s = atob(b64.replace(/\s/g, ''));
  const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a;
}

// ---------- шифрование ключа ----------

async function deriveKey(login, password, salt, iter) {
  const base = await crypto.subtle.importKey(
    'raw', utf8.encode(login.trim().toLowerCase() + '\n' + password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function seal(secret, login, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(login, password, salt, ITER);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, utf8.encode(secret)));
  return { v: 1, iter: ITER, salt: bytesToB64(salt), iv: bytesToB64(iv), data: bytesToB64(ct) };
}

// Возвращает ключ GitHub или null, если логин или пароль не подходят.
async function unseal(box, login, password) {
  const key = await deriveKey(login, password, b64ToBytes(box.salt), box.iter);
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(box.iv) }, key, b64ToBytes(box.data));
    return fromUtf8.decode(pt);
  } catch {
    return null;
  }
}

function checkNewPass(login, pass, pass2) {
  if (!login.trim()) throw new Error('Укажите логин.');
  if (pass.length < MIN_PASS) throw new Error('Пароль должен быть не короче ' + MIN_PASS + ' символов.');
  if (/^\d+$/.test(pass)) throw new Error('Пароль только из цифр легко подобрать. Нажмите «Придумать пароль».');
  const lg = login.trim().toLowerCase();
  if (lg.length >= 3 && pass.toLowerCase().includes(lg)) throw new Error('Пароль не должен содержать логин.');
  if (pass !== pass2) throw new Error('Пароли не совпадают.');
}

// 16 случайных знаков группами по 4: 32^16 вариантов, набирается на телефоне без путаницы l/1, o/0.
function makePassword() {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => abc[b % abc.length]).join('').match(/.{4}/g).join('-');
}

// ---------- GitHub API ----------

class GhError extends Error {
  constructor(status) {
    super('GitHub ' + status);
    this.status = status;
  }
}

// path '' — сам репозиторий, иначе файл в нём. GET несуществующего файла → null.
async function gh(method, path, body) {
  let r;
  try {
    r = await fetch(API + '/repos/' + REPO + (path ? '/contents/' + path : ''), {
      method,
      cache: 'no-store',
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new GhError(0);
  }
  if (r.status === 404 && method === 'GET') return null;
  if (!r.ok) throw new GhError(r.status);
  return r.json();
}

function ghMessage(e) {
  switch (e.status) {
    case 0: return 'Нет связи с GitHub. Проверьте интернет и повторите.';
    case 401: return 'Ключ GitHub недействителен или истёк. Напишите помощнику: «на сайте сбора истёк ключ GitHub».';
    case 403:
    case 404: return 'У ключа GitHub нет права записи в репозиторий ' + REPO + '.';
    case 409:
    case 422: return 'Данные изменились в другом окне или на другом устройстве. Обновите страницу и повторите.';
    default: return 'GitHub ответил ошибкой ' + e.status + '. Повторите чуть позже.';
  }
}

async function readFile(path) {
  const f = await gh('GET', path);
  return f && { sha: f.sha, text: fromUtf8.decode(b64ToBytes(f.content)) };
}

async function writeFile(path, bytes, sha, message) {
  const r = await gh('PUT', path, { message, content: bytesToB64(bytes), ...(sha ? { sha } : {}) });
  return r.content.sha;
}

// Кнопка → действие с сообщением о результате. Пока идёт одно действие, другие ждут.
async function run(btn, msgEl, fn, pending = 'Сохраняю…') {
  if (busy) {
    setMsg(msgEl, 'Подождите — ещё идёт предыдущее действие.', 'err');
    return;
  }
  busy = true;
  btn.disabled = true;
  setMsg(msgEl, pending);
  try {
    setMsg(msgEl, await fn(), 'ok');
  } catch (e) {
    console.error(e);
    setMsg(msgEl, e instanceof GhError ? ghMessage(e) : e.message, 'err');
  } finally {
    busy = false;
    btn.disabled = false;
  }
}

// ---------- данные ----------

async function loadData() {
  const f = await readFile('data.json');
  if (!f) throw new Error('В репозитории ' + REPO + ' нет data.json — проверьте адрес админки.');
  const d = JSON.parse(f.text);
  dataSha = f.sha;
  data = {
    title: d.title || '',
    about: d.about || '',
    me: d.me || '',
    mePhoto: d.mePhoto || '',
    payTo: d.payTo || '',
    payNote: d.payNote || '',
    months: Array.isArray(d.months) ? d.months : [],
    news: Array.isArray(d.news) ? d.news : [],
    updated: d.updated || null,
  };
  if (!data.months.length) data.months.push({ month: currentYm(), goal: 0, collected: 0 });
  savedMePhoto = data.mePhoto;
}

// Пишет data.json целиком. Выбранное фото «О себе» загружается первым, прежнее — удаляется.
async function save(message) {
  if (mePhotoFile) {
    const blob = await shrinkPhoto(mePhotoFile);
    const path = 'photos/me-' + Date.now().toString(36) + '.jpg';
    await writeFile(path, new Uint8Array(await blob.arrayBuffer()), null, 'Фото «О себе»');
    data.mePhoto = path;
    mePhotoFile = null;
    $('mePhotoIn').value = '';   // иначе повторный выбор того же файла не сработает
  }
  const seq = editSeq;
  data.updated = new Date().toISOString();
  dataSha = await writeFile('data.json', utf8.encode(JSON.stringify(data, null, 2) + '\n'), dataSha, message);
  dirty = editSeq !== seq;   // поправили, пока шло сохранение, — это ещё не записано
  setMsg($('saveMsg'), dirty ? 'Есть несохранённые изменения' : '');
  if (savedMePhoto && savedMePhoto !== data.mePhoto) await removeFile(savedMePhoto);
  savedMePhoto = data.mePhoto;
}

// Удаляет фото из репозитория; при ошибке файл просто останется.
async function removeFile(path) {
  path = safePhoto(path);
  if (!path) return;
  try {
    const f = await gh('GET', path);
    if (f) await gh('DELETE', path, { message: 'Удаление фото', sha: f.sha });
  } catch (e) {
    console.error(e);
  }
}

function markDirty() {
  dirty = true;
  editSeq++;
  setMsg($('saveMsg'), 'Есть несохранённые изменения');
}

function toNum(v) { return Math.max(0, Math.round(Number(v) || 0)); }

// ---------- месяцы ----------

function updatePreview() {
  const p = progress(data.months[0]);
  $('curPreview').textContent = p.goal === 0
    ? 'Укажите сумму в месяц — без неё полоска на сайте не показывается.'
    : p.done
      ? 'Собрано ' + p.pct + ' % — цель месяца собрана.'
      : 'Собрано ' + p.pct + ' % · не хватает ' + p.lackPct + ' % (' + rub(p.left) + ')';
}

function numInput(value, onChange) {
  const el = document.createElement('input');
  el.type = 'number';
  el.min = '0';
  el.step = '1';
  el.inputMode = 'numeric';
  el.value = value || '';
  el.addEventListener('input', () => { onChange(toNum(el.value)); markDirty(); });
  return el;
}

function labeled(text, input) {
  const box = document.createElement('div');
  const l = document.createElement('label');
  l.textContent = text;
  box.append(l, input);
  return box;
}

function renderMonths() {
  const cur = data.months[0];
  const curName = MONTHS[Number(cur.month.slice(5)) - 1].toLowerCase();
  $('curTitle').textContent = 'Сбор: ' + monthLabel(cur.month);
  $('collLabel').textContent = 'Собрано за ' + curName + ', ₽';
  $('goalIn').value = cur.goal || '';
  $('collIn').value = cur.collected || '';
  $('noteIn').value = cur.note || '';
  $('newMonthBtn').textContent = 'Начать новый месяц: ' + monthLabel(nextYm(cur.month));
  updatePreview();

  const list = $('pastList');
  list.replaceChildren();
  data.months.slice(1).forEach((m, k) => {
    const i = k + 1;
    const row = document.createElement('div');
    row.className = 'mrow';
    const name = document.createElement('div');
    name.className = 'mname';
    name.textContent = monthLabel(m.month);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn sm danger';
    del.textContent = 'Удалить';
    del.addEventListener('click', () => {
      if (!confirm('Удалить ' + monthLabel(m.month) + ' из истории?')) return;
      data.months.splice(i, 1);
      renderMonths();
      markDirty();
    });
    const note = document.createElement('textarea');
    note.rows = 2;
    note.value = m.note || '';
    note.addEventListener('input', () => { m.note = note.value; markDirty(); });
    const noteBox = labeled('На что', note);
    noteBox.className = 'mnote';
    row.append(
      name,
      labeled('Цель, ₽', numInput(m.goal, (v) => { m.goal = v; })),
      labeled('Собрано, ₽', numInput(m.collected, (v) => { m.collected = v; })),
      del,
      noteBox);
    list.append(row);
  });
  if (data.months.length > 1) {
    const undo = document.createElement('button');
    undo.type = 'button';
    undo.className = 'btn sm danger';
    undo.style.marginTop = '12px';
    undo.textContent = 'Удалить текущий месяц (' + monthLabel(cur.month) + ')';
    undo.addEventListener('click', () => {
      if (!confirm('Удалить ' + monthLabel(cur.month) + '? Текущим снова станет ' + monthLabel(data.months[1].month) + '.')) return;
      data.months.shift();
      renderMonths();
      markDirty();
    });
    list.append(undo);
  } else {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'Пока нет.';
    list.append(p);
  }
}

$('goalIn').addEventListener('input', () => {
  data.months[0].goal = toNum($('goalIn').value);
  markDirty();
  updatePreview();
});
$('collIn').addEventListener('input', () => {
  data.months[0].collected = toNum($('collIn').value);
  markDirty();
  updatePreview();
});
$('noteIn').addEventListener('input', () => {
  data.months[0].note = $('noteIn').value;
  markDirty();
});
$('newMonthBtn').addEventListener('click', () => {
  const cur = data.months[0];
  const nm = nextYm(cur.month);
  if (!confirm('Начать ' + monthLabel(nm) + '? ' + monthLabel(cur.month) + ' уйдёт в прошлые месяцы. Сумма в месяц и «на что» останутся прежними — поправьте, если нужно. Собрано — с нуля.')) return;
  data.months.unshift({ month: nm, goal: cur.goal, collected: 0, note: cur.note || '' });
  renderMonths();
  markDirty();
});

// ---------- тексты ----------

const TEXT_FIELDS = [['titleIn', 'title'], ['aboutIn', 'about'], ['meIn', 'me'], ['payToIn', 'payTo'], ['payNoteIn', 'payNote']];
for (const [id, field] of TEXT_FIELDS) {
  $(id).addEventListener('input', () => { data[field] = $(id).value; markDirty(); });
}

function fillForm() {
  for (const [id, field] of TEXT_FIELDS) $(id).value = data[field];
  showMePreview(safePhoto(data.mePhoto));
  renderMonths();
  renderPosts();
}

function showMePreview(src) {
  const img = $('mePreview');
  if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
  if (src) img.src = src;
  else img.removeAttribute('src');
  img.hidden = !src;
  show('meRemove', !!src);
}

$('mePreview').addEventListener('error', () => { $('mePreview').hidden = true; });

$('mePhotoIn').addEventListener('change', () => {
  const f = $('mePhotoIn').files[0];
  if (!f) {   // выбор отменили — остаётся прежнее фото
    mePhotoFile = null;
    showMePreview(safePhoto(data.mePhoto));
    return;
  }
  mePhotoFile = f;
  showMePreview(URL.createObjectURL(f));
  markDirty();
});

$('meRemove').addEventListener('click', () => {
  mePhotoFile = null;
  data.mePhoto = '';
  $('mePhotoIn').value = '';
  showMePreview('');
  markDirty();
});

$('saveBtn').addEventListener('click', () => run($('saveBtn'), $('saveMsg'), async () => {
  await save('Обновление данных сбора');
  return dirty
    ? 'Сохранено, но вы успели ещё что-то поправить — нажмите «Сохранить» ещё раз.'
    : 'Сохранено. На сайте — примерно через минуту.';
}));

// Записи публикуются вместе со всем data.json — несохранённые правки выше не должны уйти случайно.
function requireSaved() {
  if (dirty) throw new Error('Сначала нажмите «Сохранить» — выше есть несохранённые правки.');
}

// ---------- записи с фото ----------

// Уменьшает фото до 1600 px по длинной стороне, JPEG.
async function shrinkPhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
    } catch {
      throw new Error('Не удалось открыть фото. Выберите снимок в формате JPG или PNG.');
    }
    const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k);
    c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.82));
  } finally {
    URL.revokeObjectURL(url);
  }
}

$('newsPhoto').addEventListener('change', () => {
  const img = $('newsPreview');
  if (img.src) URL.revokeObjectURL(img.src);
  const f = $('newsPhoto').files[0];
  img.src = f ? URL.createObjectURL(f) : '';
  img.hidden = !f;
});

$('publishBtn').addEventListener('click', () => run($('publishBtn'), $('newsMsg'), async () => {
  const text = $('newsText').value.trim();
  const file = $('newsPhoto').files[0];
  if (!text && !file) throw new Error('Напишите текст или выберите фото.');
  requireSaved();
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const item = { id, date: todayYmd(), text };
  if (file) {
    setMsg($('newsMsg'), 'Загружаю фото…');
    const blob = await shrinkPhoto(file);
    item.photo = 'photos/' + item.date + '-' + id + '.jpg';
    await writeFile(item.photo, new Uint8Array(await blob.arrayBuffer()), null, 'Фото к записи');
  }
  data.news.unshift(item);
  try {
    requireSaved();   // ещё раз: пока грузилось фото, могли поправить форму
    await save('Новая запись');
  } catch (e) {
    data.news.shift();
    // GitHub явно отказал (или правки формы) — фото без записи не нужно; при обрыве связи
    // запись могла лечь, тогда её фото трогать нельзя
    if (item.photo && e.status !== 0) await removeFile(item.photo);
    throw e;
  }
  $('newsText').value = '';
  $('newsPhoto').value = '';
  $('newsPhoto').dispatchEvent(new Event('change'));
  renderPosts();
  return 'Опубликовано. На сайте — примерно через минуту.';
}, 'Публикую…'));

function renderPosts() {
  const list = $('postList');
  list.replaceChildren();
  for (const n of data.news) {
    const row = document.createElement('div');
    row.className = 'adm-post';
    if (safePhoto(n.photo)) {
      const img = document.createElement('img');
      img.src = safePhoto(n.photo);
      img.alt = '';
      img.loading = 'lazy';
      img.onerror = () => { img.hidden = true; };
      row.append(img);
    }
    const t = document.createElement('div');
    t.className = 't';
    const b = document.createElement('b');
    b.textContent = dayLabel(n.date) + (n.photo ? ' · фото' : '');
    const p = document.createElement('p');
    p.textContent = n.text;
    t.append(b, p);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn sm danger';
    del.textContent = 'Удалить';
    del.addEventListener('click', () => deletePost(n.id, del));
    row.append(t, del);
    list.append(row);
  }
  show('noPosts', data.news.length === 0);
}

function deletePost(id, btn) {
  if (!confirm('Удалить запись? Она пропадёт с сайта.')) return;
  run(btn, $('postMsg'), async () => {
    requireSaved();
    const i = data.news.findIndex((n) => n.id === id);
    if (i < 0) throw new Error('Запись не найдена. Обновите страницу.');
    const [item] = data.news.splice(i, 1);
    try {
      await save('Удаление записи');
    } catch (e) {
      data.news.splice(i, 0, item);
      throw e;
    }
    renderPosts();
    if (item.photo) await removeFile(item.photo);
    return 'Запись удалена.';
  }, 'Удаляю…');
}

// ---------- вход и настройка входа ----------

async function writeKey(login, pass, message) {
  const box = await seal(token, login, pass);
  const f = await gh('GET', 'admin-key.json');
  await writeFile('admin-key.json', utf8.encode(JSON.stringify(box, null, 2) + '\n'), f && f.sha, message);
  keyBox = box;
}

// fresh — после входа или настройки: срок 12 часов отсчитывается отсюда и при перезагрузке не продлевается.
async function startSession(fresh = true) {
  try {
    await loadData();
  } catch (e) {
    token = null;
    clearSession();
    throw e;
  }
  if (fresh) saveSession();
  fillForm();
  show('loading', false);
  show('setupSec', false);
  show('loginSec', false);
  show('app', true);
}

$('setupForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const btn = ev.submitter || $('setupForm').querySelector('button');
  run(btn, $('setupMsg'), async () => {
    checkNewPass($('sLogin').value, $('sPass').value, $('sPass2').value);
    token = $('sToken').value.trim();
    // классический ключ ghp_… даёт доступ ко всем репозиториям — его в открытый файл класть нельзя
    if (!token.startsWith('github_pat_')) throw new Error('Нужен ключ типа Fine-grained: он начинается с github_pat_.');
    try {
      if (!await gh('GET', '')) throw new Error('Репозиторий ' + REPO + ' не найден для этого ключа.');
    } catch (e) {
      if (e.status === 401) throw new Error('Ключ не подходит. Проверьте, что он скопирован целиком.');
      throw e;
    }
    await writeKey($('sLogin').value, $('sPass').value, 'Настройка входа в админку');
    await startSession();
    $('setupForm').reset();
    return '';
  });
});

$('loginForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const btn = ev.submitter || $('loginForm').querySelector('button');
  run(btn, $('loginMsg'), async () => {
    const t = await unseal(keyBox, $('lLogin').value, $('lPass').value);
    if (!t) throw new Error('Неверный логин или пароль.');
    token = t;
    await startSession();
    return '';
  }, 'Проверяю…');
});

$('genPass').addEventListener('click', () => {
  const p = makePassword();
  for (const id of ['sPass', 'sPass2']) {
    $(id).type = 'text';   // помощнику нужно его увидеть и переслать админу
    $(id).value = p;
  }
});

$('toSetup').addEventListener('click', (ev) => {
  ev.preventDefault();
  show('loginSec', false);
  show('setupSec', true);
  show('backToLogin', true);
});

$('toLogin').addEventListener('click', (ev) => {
  ev.preventDefault();
  show('setupSec', false);
  show('loginSec', true);
});

$('logoutBtn').addEventListener('click', (ev) => {
  ev.preventDefault();
  if (dirty && !confirm('Есть несохранённые изменения. Всё равно выйти?')) return;
  dirty = false;
  clearSession();
  location.reload();
});

window.addEventListener('beforeunload', (ev) => {
  if (dirty) { ev.preventDefault(); ev.returnValue = ''; }
});

function fatal(text) {
  show('loading', false);
  $('fatal').textContent = text;
  show('fatal', true);
}

async function init() {
  if (!REPO) {
    fatal('Админка работает только на опубликованном сайте (адрес вида имя.github.io/репозиторий).');
    return;
  }
  if (!window.crypto || !crypto.subtle) {
    fatal('Браузер не умеет шифрование. Откройте страницу по https в современном браузере.');
    return;
  }
  const saved = readSession();
  if (saved) {
    token = saved;
    try {
      await startSession(false);
      return;
    } catch { /* ключ из прошлой вкладки не подошёл — обычный вход */ }
  }
  let r;
  try {
    r = await fetch('admin-key.json?v=' + Date.now(), { cache: 'no-store' });
  } catch {
    fatal('Нет связи. Проверьте интернет и обновите страницу.');
    return;
  }
  if (r.ok) keyBox = await r.json();
  else if (r.status !== 404) {
    fatal('Сайт ответил ошибкой ' + r.status + '. Обновите страницу.');
    return;
  }
  show('loading', false);
  show(keyBox ? 'loginSec' : 'setupSec', true);
}

init();
