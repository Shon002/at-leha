// Общее для сайта и админки: числа, месяцы, проценты, чтение data.json.

const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

const numFmt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });

function rub(n) {
  return numFmt.format(Math.round(Number(n) || 0)) + ' ₽';
}

// '2026-10' -> 'Октябрь 2026'
function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return MONTHS[m - 1] + ' ' + y;
}

// '2026-10-14' -> '14 октября 2026'
function dayLabel(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return d + ' ' + MONTHS_GEN[m - 1] + ' ' + y;
}

function pad2(n) { return String(n).padStart(2, '0'); }

function todayYmd() {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function currentYm() { return todayYmd().slice(0, 7); }

function nextYm(ym) {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? (y + 1) + '-01' : y + '-' + pad2(m + 1);
}

// Сколько собрано и сколько не хватает. Проценты целые: собрано округляется вниз,
// чтобы «100 %» появлялось только когда цель действительно собрана.
function progress(month) {
  const goal = Math.max(0, Number(month && month.goal) || 0);
  const collected = Math.max(0, Number(month && month.collected) || 0);
  const pct = goal > 0 ? Math.floor(collected * 100 / goal) : 0;
  return {
    goal,
    collected,
    pct,
    left: Math.max(0, goal - collected),
    lackPct: Math.max(0, 100 - pct),
    done: goal > 0 && collected >= goal,
  };
}

// Путь к фото из data.json: только файлы, которые кладёт сама админка.
function safePhoto(p) {
  return typeof p === 'string' && /^photos\/[\w.-]+\.jpg$/.test(p) ? p : '';
}

async function loadPublicData() {
  const r = await fetch('data.json?v=' + Date.now(), { cache: 'no-store' });
  if (!r.ok) throw new Error('data.json: ' + r.status);
  return r.json();
}
