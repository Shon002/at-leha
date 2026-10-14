// Публичная страница: полоска месяца, реквизиты, новости и картинка-отчёт.

const $ = (id) => document.getElementById(id);
let data = null;

function show(id, on) { $(id).hidden = !on; }

function dateOf(iso) {
  const d = new Date(iso);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function render(d) {
  document.title = d.title || 'Ежемесячный сбор';
  $('title').textContent = d.title || 'Ежемесячный сбор';

  // текущий месяц
  const m = d.months && d.months[0];
  const p = progress(m);
  $('monthLabel').textContent = monthLabel(m ? m.month : currentYm());
  show('meter', true);
  show('noGoal', p.goal === 0);
  show('hasGoal', p.goal > 0);
  show('pill', p.goal > 0);
  if (p.goal > 0) {
    $('collected').textContent = rub(p.collected);
    $('goal').textContent = rub(p.goal);
    $('pct').textContent = p.pct + ' %';
    $('left').textContent = rub(p.left);
    $('pill').textContent = p.done ? 'Цель собрана!' : 'не хватает ' + p.lackPct + ' %';
    $('pill').classList.toggle('done', p.done);
    $('bar').setAttribute('aria-valuenow', String(Math.min(p.pct, 100)));
    requestAnimationFrame(() => { $('fill').style.width = Math.min(p.pct, 100) + '%'; });
  }

  // как помочь
  $('payTo').textContent = d.payTo || '';
  $('payNote').textContent = d.payNote || '';
  show('paytoRow', !!d.payTo);
  show('help', !!(d.payTo || d.payNote));

  $('about').textContent = d.about || '';
  show('aboutSec', !!d.about);

  const mePhoto = safePhoto(d.mePhoto);
  $('me').textContent = d.me || '';
  if (mePhoto) $('mePhoto').src = mePhoto;
  show('mePhoto', !!mePhoto);
  show('meSec', !!(d.me || mePhoto));

  // прошлые месяцы
  const past = (d.months || []).slice(1);
  const ul = $('history');
  ul.replaceChildren();
  for (const pm of past) {
    const pp = progress(pm);
    const li = document.createElement('li');
    const row = document.createElement('div');
    row.className = 'row';
    const a = document.createElement('span');
    a.textContent = monthLabel(pm.month);
    const b = document.createElement('span');
    b.textContent = rub(pp.collected) + ' из ' + rub(pp.goal) + ' · ' + pp.pct + ' %';
    row.append(a, b);
    const bar = document.createElement('div');
    bar.className = 'bar slim';
    const fill = document.createElement('div');
    fill.className = 'fill';
    fill.style.width = Math.min(pp.pct, 100) + '%';
    bar.append(fill);
    li.append(row, bar);
    ul.append(li);
  }
  show('historySec', past.length > 0);

  // новости
  const box = $('news');
  box.replaceChildren();
  for (const n of d.news || []) {
    const art = document.createElement('article');
    art.className = 'card post';
    const photo = safePhoto(n.photo);
    if (photo) {
      const link = document.createElement('a');
      link.className = 'photo';
      link.href = photo;
      link.target = '_blank';
      link.rel = 'noopener';
      const img = document.createElement('img');
      img.src = photo;
      img.alt = '';
      img.loading = 'lazy';
      link.append(img);
      art.append(link);
    }
    const body = document.createElement('div');
    body.className = 'body';
    const t = document.createElement('time');
    t.dateTime = n.date;
    t.textContent = dayLabel(n.date);
    body.append(t);
    if (n.text) {
      const p2 = document.createElement('p');
      p2.className = 'pre';
      p2.textContent = n.text;
      body.append(p2);
    }
    art.append(body);
    box.append(art);
  }
  show('newsSec', (d.news || []).length > 0);

  $('updated').textContent = d.updated ? 'Обновлено ' + dayLabel(dateOf(d.updated)) : '';
  show('sep', !!d.updated);
}

// ---------- копирование номера ----------

$('copyBtn').addEventListener('click', async () => {
  const text = $('payTo').textContent;
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    const r = document.createRange();
    r.selectNodeContents($('payTo'));
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
    ok = document.execCommand('copy');
  }
  $('copyBtn').textContent = ok ? 'Скопировано' : 'Выделено — скопируйте';
  setTimeout(() => { $('copyBtn').textContent = 'Скопировать'; }, 2000);
});

// ---------- картинка-отчёт ----------

const W = 1080, H = 1350, PAD = 80;
const RC = {
  bg: '#1D2340', ink: '#F4EEE4', muted: '#A6A9C2',
  a1: '#E8553D', a2: '#F5A524',
  track: 'rgba(255,255,255,0.13)', box: 'rgba(255,255,255,0.07)',
};
const FONT_SAMPLE = 'Собрано из на месяц 0123456789 ₽ %·— ABC';

function roundRect(x, left, top, w, h, r) {
  x.beginPath();
  x.moveTo(left + r, top);
  x.arcTo(left + w, top, left + w, top + h, r);
  x.arcTo(left + w, top + h, left, top + h, r);
  x.arcTo(left, top + h, left, top, r);
  x.arcTo(left, top, left + w, top, r);
  x.closePath();
  x.fill();
}

// Разбивает текст на строки по ширине; лишние строки отрезаются с «…».
function wrapLines(x, text, maxW, maxLines) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const test = line ? line + ' ' + word : word;
      if (x.measureText(test).width <= maxW || !line) line = test;
      else { lines.push(line); line = word; }
    }
    if (line) lines.push(line);
  }
  if (lines.length > maxLines) {
    lines.length = maxLines;
    let last = lines[maxLines - 1];
    while (last && x.measureText(last + '…').width > maxW) last = last.slice(0, -1);
    lines[maxLines - 1] = last.trimEnd() + '…';
  }
  return lines;
}

// Уменьшает шрифт, пока текст не влезет в ширину.
function fitFont(x, text, weight, size, family, maxW) {
  do {
    x.font = weight + ' ' + size + 'px ' + family;
    size -= 4;
  } while (x.measureText(text).width > maxW && size > 20);
}

async function drawReport(d) {
  const m = d.months[0];
  const p = progress(m);
  try {
    await Promise.all([
      '800 116px Unbounded', '700 56px Unbounded',
      '800 30px Manrope', '700 34px Manrope', '600 28px Manrope',
    ].map((f) => document.fonts.load(f, FONT_SAMPLE)));
  } catch { /* шрифт не загрузился — рисуем системным */ }

  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const x = c.getContext('2d');
  const maxW = W - 2 * PAD;

  x.fillStyle = RC.bg;
  x.fillRect(0, 0, W, H);
  const sun = x.createRadialGradient(W - 40, 40, 0, W - 40, 40, 640);
  sun.addColorStop(0, 'rgba(245,165,36,0.50)');
  sun.addColorStop(0.45, 'rgba(232,85,61,0.22)');
  sun.addColorStop(1, 'rgba(232,85,61,0)');
  x.fillStyle = sun;
  x.fillRect(0, 0, W, H);

  let y = 130;
  x.fillStyle = RC.a2;
  x.font = '800 30px Manrope, sans-serif';
  if ('letterSpacing' in x) x.letterSpacing = '3px';
  x.fillText(('Ежемесячный сбор · ' + monthLabel(m.month)).toUpperCase(), PAD, y);
  if ('letterSpacing' in x) x.letterSpacing = '0px';

  y += 10;
  x.fillStyle = RC.ink;
  x.font = '700 56px Unbounded, sans-serif';
  for (const line of wrapLines(x, d.title || '', maxW, 2)) {
    y += 70;
    x.fillText(line, PAD, y);
  }

  y += 86;
  x.fillStyle = RC.muted;
  x.font = '700 34px Manrope, sans-serif';
  x.fillText('Собрано', PAD, y);

  y += 114;
  x.fillStyle = RC.ink;
  fitFont(x, rub(p.collected), '800', 116, 'Unbounded, sans-serif', maxW);
  x.fillText(rub(p.collected), PAD, y);

  y += 58;
  x.fillStyle = RC.muted;
  x.font = '600 38px Manrope, sans-serif';
  x.fillText('из ' + rub(p.goal) + ' на месяц', PAD, y);

  y += 44;
  const bh = 56;
  x.fillStyle = RC.track;
  roundRect(x, PAD, y, maxW, bh, bh / 2);
  if (p.pct > 0) {
    const g = x.createLinearGradient(PAD, 0, PAD + maxW, 0);
    g.addColorStop(0, RC.a1);
    g.addColorStop(1, RC.a2);
    x.fillStyle = g;
    roundRect(x, PAD, y, Math.max(bh, maxW * Math.min(p.pct, 100) / 100), bh, bh / 2);
  }

  y += bh + 54;
  x.font = '800 36px Manrope, sans-serif';
  x.fillStyle = RC.ink;
  x.fillText(p.pct + ' % собрано', PAD, y);
  x.textAlign = 'right';
  x.fillStyle = RC.a2;
  x.fillText(p.done ? 'цель собрана' : 'не хватает ' + p.lackPct + ' %', W - PAD, y);
  x.textAlign = 'left';

  y += 88;
  if (p.done) {
    x.fillStyle = RC.a2;
    x.font = '700 52px Unbounded, sans-serif';
    for (const line of wrapLines(x, 'Цель месяца собрана — спасибо!', maxW, 2)) {
      x.fillText(line, PAD, y);
      y += 64;
    }
  } else {
    x.fillStyle = RC.muted;
    x.font = '700 34px Manrope, sans-serif';
    x.fillText('Осталось собрать', PAD, y);
    y += 92;
    x.fillStyle = RC.a2;
    fitFont(x, rub(p.left), '800', 84, 'Unbounded, sans-serif', maxW);
    x.fillText(rub(p.left), PAD, y);
  }

  // как помочь
  const top = H - 370;
  x.fillStyle = RC.box;
  roundRect(x, PAD - 32, top, W - 2 * PAD + 64, 280, 28);
  let by = top + 58;
  x.fillStyle = RC.muted;
  x.font = '700 30px Manrope, sans-serif';
  x.fillText('Как помочь', PAD, by);
  if (d.payTo) {
    by += 68;
    x.fillStyle = RC.ink;
    fitFont(x, d.payTo, '700', 50, 'Unbounded, sans-serif', maxW);
    x.fillText(d.payTo, PAD, by);
  }
  by += 22;
  x.fillStyle = RC.muted;
  x.font = '600 27px Manrope, sans-serif';
  for (const line of wrapLines(x, d.payNote || '', maxW, d.payTo ? 3 : 5)) {
    by += 37;
    x.fillText(line, PAD, by);
  }

  // подвал: адрес сайта и дата
  const site = (location.host + location.pathname.replace(/index\.html$/, '')).replace(/\/$/, '');
  const asOf = d.updated ? dateOf(d.updated) : todayYmd();
  x.font = '600 28px Manrope, sans-serif';
  x.fillStyle = RC.muted;
  x.fillText(site, PAD, H - 50);
  x.textAlign = 'right';
  x.fillText('на ' + asOf.split('-').reverse().join('.'), W - PAD, H - 50);
  x.textAlign = 'left';

  return new Promise((res) => c.toBlob(res, 'image/png'));
}

let reportFile = null;

$('reportBtn').addEventListener('click', async () => {
  const btn = $('reportBtn');
  btn.disabled = true;
  try {
    const blob = await drawReport(data);
    reportFile = new File([blob], 'sbor-' + data.months[0].month + '.png', { type: 'image/png' });
    const img = $('reportImg');
    if (img.src) URL.revokeObjectURL(img.src);
    img.src = URL.createObjectURL(blob);
    show('shareBtn', !!(navigator.canShare && navigator.canShare({ files: [reportFile] })));
    $('reportDlg').showModal();
  } catch (e) {
    console.error(e);
    alert('Не получилось сделать картинку. Попробуйте ещё раз.');
  } finally {
    btn.disabled = false;
  }
});

$('downloadBtn').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = $('reportImg').src;
  a.download = reportFile.name;
  document.body.append(a);
  a.click();
  a.remove();
});

$('shareBtn').addEventListener('click', async () => {
  try {
    await navigator.share({ files: [reportFile], title: data.title });
  } catch { /* пользователь закрыл окно «Поделиться» */ }
});

$('closeBtn').addEventListener('click', () => $('reportDlg').close());

loadPublicData()
  .then((d) => { data = d; render(d); })
  .catch(() => {
    $('title').textContent = 'Ежемесячный сбор';
    show('loadErr', true);
  });
