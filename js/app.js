/* Grochu's makro — dziennik posiłków z AI: zdjęcie talerza → nazwa, składniki, kalorie i makro. Dane w localStorage + Supabase (js/cloud.js). */
(() => {
  'use strict';

  const STORAGE_KEY = 'gmakro.v1';
  const DAYS_FULL = ['Poniedziałek', 'Wtorek', 'Środa', 'Czwartek', 'Piątek', 'Sobota', 'Niedziela'];
  const DAYS = ['Pn', 'Wt', 'Śr', 'Cz', 'Pt', 'So', 'Nd'];
  const MONTHS_GEN = ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca', 'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia'];
  const TYPES = [['br', 'Śniadanie'], ['lu', 'Obiad'], ['di', 'Kolacja'], ['sn', 'Przekąska']];
  const typeName = t => (TYPES.find(x => x[0] === t) || TYPES[3])[1];
  const DEF_GOALS = { kcal: 2200, p: 140, f: 70, c: 250 };

  /* ---------- daty ---------- */
  const pad = n => String(n).padStart(2, '0');
  const key = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fromKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const dow = d => (d.getDay() + 6) % 7; // 0 = poniedziałek
  const todayKey = () => key(new Date());
  const dayOnly = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const nowTime = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const typeByHour = h => h < 11 ? 'br' : h < 17 ? 'lu' : h < 22 ? 'di' : 'sn';
  const dateLabel = k => { const d = fromKey(k); return `${DAYS_FULL[dow(d)]}, ${d.getDate()} ${MONTHS_GEN[d.getMonth()]}`; };
  const relDay = k => { const t = todayKey(); return k === t ? 'Dziś' : k === key(addDays(new Date(), -1)) ? 'Wczoraj' : k === key(addDays(new Date(), 1)) ? 'Jutro' : null; };

  /* ---------- stan ---------- */
  const withDefaults = s => {
    s = s && typeof s === 'object' ? s : {};
    s.goals = { ...DEF_GOALS, ...(s.goals || {}) };
    if (!s.meals || typeof s.meals !== 'object') s.meals = {};
    return s;
  };
  function load() {
    try { const raw = localStorage.getItem(STORAGE_KEY); if (raw) return withDefaults(JSON.parse(raw)); } catch (_) { }
    return withDefaults({});
  }
  let state = load();
  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch (_) { toast('Nie udało się zapisać danych w przeglądarce'); return; }
    window.Cloud?.changed();
  }
  // Stan z chmury: zapis lokalny bez oznaczania go jako zmiany z tego urządzenia.
  function applyState(s) {
    state = withDefaults({ goals: s.goals, meals: s.meals || {} });
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) { }
    render();
  }

  let view = 'day', selDay = dayOnly(new Date()), slideDir = 0, animList = true, hello = true;
  let sumDays = 7, hQuery = '', hLimit = 14, freshId = null;
  try { const v = localStorage.getItem('gmakro.view'); if (v === 'history' || v === 'summary') view = v; } catch (_) { }
  const mq = window.matchMedia('(max-width:680px)');
  const isMobile = () => mq.matches;
  const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- liczenie ---------- */
  const r0 = v => Math.round(v || 0);
  const r1 = v => Math.round((v || 0) * 10) / 10;
  const nf = v => (+v || 0).toLocaleString('pl-PL', { maximumFractionDigits: 1 });
  function totals(items) {
    return (items || []).reduce((a, it) => ({ kcal: a.kcal + (+it.kcal || 0), p: a.p + (+it.p || 0), f: a.f + (+it.f || 0), c: a.c + (+it.c || 0), g: a.g + (+it.g || 0) }), { kcal: 0, p: 0, f: 0, c: 0, g: 0 });
  }
  const mealsOn = k => Object.values(state.meals).filter(m => m.day === k).sort((a, b) => (a.at || '').localeCompare(b.at || ''));
  const dayTotals = k => mealsOn(k).reduce((a, m) => { const t = totals(m.items); ['kcal', 'p', 'f', 'c'].forEach(x => a[x] += t[x]); return a; }, { kcal: 0, p: 0, f: 0, c: 0 });
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const uid = () => 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  /* ---------- ikony ---------- */
  const wavePath = (amp, len) => { let d = 'M0 20'; for (let x = 0; x < 400; x += len) d += ` Q${x + len / 4} ${20 - amp} ${x + len / 2} 20 T${x + len} 20`; return d + ' V40 H0 Z'; };
  const SEA_SVG = `<svg class="waves" viewBox="0 0 200 40" preserveAspectRatio="none" aria-hidden="true"><path class="w1" d="${wavePath(5, 50)}"/><path class="w2" d="${wavePath(7, 100)}" transform="translate(0 3)"/><path class="w3" d="${wavePath(3, 50)}" transform="translate(0 9)"/></svg>`;
  const BOAT = '<svg width="26" height="24" viewBox="0 0 26 24" aria-hidden="true"><path d="M12 2v14H4z" fill="currentColor" opacity=".9"/><path d="M14 5v11h7z" fill="currentColor" opacity=".55"/><path d="M2 18h22l-3 4H6z" fill="currentColor"/></svg>';
  const XMARK = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>';
  const PLUS = '<svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 1.5v11M1.5 7h11" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
  const CAM = '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.2l1.3-2h6l1.3 2h1.2A2.5 2.5 0 0 1 20 8.5v8A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><circle cx="12" cy="12.5" r="3.4" stroke="currentColor" stroke-width="1.7"/></svg>';
  const GALLERY = '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" stroke="currentColor" stroke-width="1.7"/><circle cx="9" cy="9.5" r="1.7" fill="currentColor"/><path d="M4 17l4.5-4.5 3 3 3.5-4 5 5.5" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>';
  const PLATE = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="4.5" stroke="currentColor" stroke-width="1.3" opacity=".6"/></svg>';
  const AGAIN = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.8h-2.8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const SEARCH = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="4.6" stroke="currentColor" stroke-width="1.7"/><path d="M10.5 10.5l3.2 3.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';

  const $ = id => document.getElementById(id);
  const overlay = $('overlay');

  /* ---------- płynne liczby ---------- */
  const shown = new Map();
  function countTo(el, v, dur = 450) {
    if (!el) return;
    const id = el.id || el.dataset.cnt; const from = shown.has(id) ? shown.get(id) : v; shown.set(id, v);
    if (document.hidden || from === v || calm()) { el.textContent = r0(v).toLocaleString('pl-PL'); return; }
    const t0 = performance.now();
    const tick = now => { const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3); el.textContent = r0(from + (v - from) * e).toLocaleString('pl-PL'); if (k < 1) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    setTimeout(() => { el.textContent = r0(v).toLocaleString('pl-PL'); }, dur + 80); // zapas, gdy karta w tle wstrzyma klatki
  }
  // Wysokość wody w kole tak, żeby zalana POWIERZCHNIA odpowiadała % celu (jak w trackerze).
  const waterLevel = f => {
    if (f <= 0 || f >= 1) return Math.max(0, Math.min(1, f)) * 100;
    let lo = 0, hi = Math.PI * 2;
    for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if ((m - Math.sin(m)) / (2 * Math.PI) < f) lo = m; else hi = m; }
    return +((1 - Math.cos(lo / 2)) / 2 * 100).toFixed(1);
  };

  /* ---------- rysowanie ---------- */
  let prevRing = null, prevDayTot = null, prevDayKey = null;
  function render() {
    const t = todayKey(), k = key(selDay);
    document.querySelectorAll('.vtab[data-view]').forEach(b => b.setAttribute('aria-selected', b.dataset.view === view));
    $('view-day').hidden = view !== 'day';
    $('view-history').hidden = view !== 'history';
    $('view-summary').hidden = view !== 'summary';
    $('go-today').closest('.weeknav').hidden = !(view === 'day' && k !== t);
    // nagłówek: w widoku dnia na samej górze dzień tygodnia i data ze strzałkami; w innych widokach sam tytuł
    if (view === 'day') {
      const d = fromKey(k);
      $('top-l').innerHTML = `<div class="dnav"><button class="navarr" data-nav="-1" aria-label="Poprzedni dzień">‹</button><button class="dayname${k === t ? ' t' : ''}${slideDir > 0 ? ' sl' : slideDir < 0 ? ' sr' : ''}" data-today title="Wróć do dziś">${DAYS_FULL[dow(d)]}<em>, ${d.getDate()} ${MONTHS_GEN[d.getMonth()]}</em></button><button class="navarr" data-nav="1" aria-label="Następny dzień">›</button></div>`;
    } else $('top-l').innerHTML = `<h1 class="ttl">${view === 'history' ? 'Historia' : 'Podsumowanie'}</h1>`;
    if (view === 'day') renderDay(k);
    else if (view === 'history') renderHistory();
    else renderSummary();
    animList = false; slideDir = 0; hello = false;
  }

  function macroRow(cls, label, v, goal) {
    const p = goal ? v / goal : 0;
    return `<div class="mac ${cls}${p >= 1 ? ' hit' : ''}" data-mac="${cls}"><span><i></i>${label}</span><b><em data-cnt="mac-${cls}">${r0(v)}</em> / ${nf(goal)} g</b><div class="tube${p > 1.15 ? ' over' : ''}"><i style="width:${Math.min(100, p * 100)}%"></i></div></div>`;
  }
  function mealHtml(m, i, opts = {}) {
    const t = totals(m.items);
    const th = m.th ? `<img src="${esc(m.th)}" alt="" loading="lazy">` : PLATE;
    return `<button class="meal${m.id === freshId ? ' fresh' : ''}" data-meal="${m.id}" style="--i:${i}"><span class="th${m.ai ? ' ai' : ''}">${th}</span><span class="nt"><b>${esc(m.name || 'Posiłek')}</b><small>${opts.type ? `<i>${typeName(m.type)}</i> · ` : ''}${m.at ? m.at + ' · ' : ''}B ${r0(t.p)} · T ${r0(t.f)} · W ${r0(t.c)} g</small></span><span class="kc">${r0(t.kcal)}<span>kcal</span></span>${opts.again ? `<span class="again" role="button" tabindex="0" data-again="${m.id}" aria-label="Dodaj dziś jeszcze raz" title="Dodaj dziś jeszcze raz">${AGAIN}<span>Dodaj dziś</span></span>` : ''}</button>`;
  }

  function renderDay(k) {
    const el = $('view-day'), t = todayKey(), tot = dayTotals(k), g = state.goals, meals = mealsOn(k);
    const p = g.kcal ? tot.kcal / g.kcal : 0;
    const lv = waterLevel(Math.min(1, p));
    // historia tego dnia: najnowsze posiłki na górze (pełna historia jest w menu)
    const newest = meals.slice().sort((a, b) => (b.at || '').localeCompare(a.at || '') || (b.created || 0) - (a.created || 0));
    let list = meals.length ? `<div class="mgrp" style="--i:0"><h3>Posiłki<em>${meals.length} · ${r0(tot.kcal)} kcal</em></h3></div>` + newest.map((m, i) => mealHtml(m, i + 1, { type: true })).join('') : `<p class="empty">Brak posiłków tego dnia</p>`;
    const ring = `<div class="ring${p > 1.1 ? ' over' : ''}" style="--lv:${lv}" data-lvk="${k}"><i class="wv"></i><i class="wv b"></i><div class="ring-t"><small>zjedzone</small><b data-cnt="ring-kcal">${r0(tot.kcal)}</b><small>z ${nf(g.kcal)} kcal</small><em>${Math.round(p * 100)}%</em></div></div>`;
    el.className = slideDir > 0 ? 'slide-l' : slideDir < 0 ? 'slide-r' : '';
    el.innerHTML = `<div class="dgrid dslide"><div class="panel">${ring}<div class="macros">${macroRow('p', 'Białko', tot.p, g.p)}${macroRow('f', 'Tłuszcze', tot.f, g.f)}${macroRow('c', 'Węglowodany', tot.c, g.c)}</div></div>
      <div class="mlist${hello ? ' hello' : animList || slideDir ? ' enter' : ''}">${list}</div></div>`;
    if (slideDir) { el.querySelector('.dslide').style.animation = 'none'; void el.offsetWidth; el.querySelector('.dslide').style.animation = ''; }
    // liczby i woda płyną od poprzedniego stanu tego samego dnia
    const sameDay = prevDayKey === k && prevDayTot;
    if (sameDay) {
      shown.set('ring-kcal', prevDayTot.kcal); ['p', 'f', 'c'].forEach(x => shown.set('mac-' + x, prevDayTot[x]));
    } else { shown.delete('ring-kcal'); ['p', 'f', 'c'].forEach(x => shown.delete('mac-' + x)); }
    countTo(el.querySelector('[data-cnt="ring-kcal"]'), tot.kcal, 700);
    ['p', 'f', 'c'].forEach(x => countTo(el.querySelector(`[data-cnt="mac-${x}"]`), tot[x], 700));
    const ringEl = el.querySelector('.ring');
    if (!calm()) {
      const from = sameDay ? prevRing : 0;
      if (from !== lv) {
        const top = l => `calc(4% + ${(100 - l) * .96}%)`;
        ringEl.querySelectorAll('.wv').forEach(w => w.animate({ top: [top(from), top(lv)] }, { duration: sameDay ? 900 : 1300, easing: 'cubic-bezier(.3,.7,.3,1)' }));
        if (sameDay && lv > from) ringEl.classList.add('pop');
      }
      // rurki makro: przy wejściu napełniają się od zera
      if (!sameDay) el.querySelectorAll('.tube i').forEach((bar, j) => { const w = bar.style.width; bar.style.transition = 'none'; bar.style.width = '0'; requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.transition = ''; bar.style.transitionDelay = (150 + j * 120) + 'ms'; bar.style.width = w; })); });
      else if (prevDayTot) el.querySelectorAll('.tube i').forEach(bar => { const mc = bar.closest('.mac').dataset.mac, w = bar.style.width, was = Math.min(100, (prevDayTot[mc] / (g[mc] || 1)) * 100); bar.style.transition = 'none'; bar.style.width = was + '%'; requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.transition = ''; bar.style.width = w; })); });
    }
    // przekroczenie progów: 100% kalorii = fala przez ekran, cel makro = bąbelki z rurki
    if (sameDay && userAct) {
      const was = prevDayTot;
      if (was.kcal < g.kcal && tot.kcal >= g.kcal && tot.kcal <= g.kcal * 1.1) setTimeout(() => celebrate(), 500);
      ['p', 'f', 'c'].forEach(x => { if (was[x] < g[x] && tot[x] >= g[x]) setTimeout(() => { const tb = el.querySelector(`.mac.${x} .tube`); if (tb) bubbles(tb, 14); }, 700); });
    }
    if (freshId) { const fm = el.querySelector(`[data-meal="${freshId}"] .th`); if (fm) setTimeout(() => bubbles(fm), 350); freshId = null; }
    prevRing = lv; prevDayTot = tot; prevDayKey = k; userAct = false;
  }

  function renderHistory() {
    const el = $('view-history'), q = hQuery.trim().toLowerCase();
    const all = Object.values(state.meals).filter(m => !q || (m.name || '').toLowerCase().includes(q) || (m.items || []).some(it => (it.n || '').toLowerCase().includes(q)));
    const byDay = new Map();
    all.sort((a, b) => (b.day + (b.at || '')).localeCompare(a.day + (a.at || ''))).forEach(m => { if (!byDay.has(m.day)) byDay.set(m.day, []); byDay.get(m.day).push(m); });
    const days = [...byDay.keys()].slice(0, hLimit), g = state.goals;
    let i = 0, html = '';
    days.forEach(k => {
      const ms = byDay.get(k).slice().reverse(), tot = ms.reduce((a, m) => a + totals(m.items).kcal, 0), rel = relDay(k);
      html += `<div class="hday" data-goday="${k}" style="--i:${i++}"><h3>${rel ? rel + ' <em>· ' + dateLabel(k) + '</em>' : dateLabel(k)}</h3><b>${r0(tot)} kcal</b><div class="tube${tot > g.kcal * 1.1 ? ' over' : ''}" style="--m:var(--accent)"><i style="width:${Math.min(100, tot / g.kcal * 100)}%"></i></div></div>`;
      html += ms.map(m => mealHtml(m, i++, { type: true, again: true })).join('');
    });
    if (!days.length) html = `<p class="empty">${q ? 'Nic nie pasuje do wyszukiwania' : 'Tu pojawią się zeskanowane posiłki'}</p>`;
    if (byDay.size > hLimit) html += `<button class="allweek more" data-more>Pokaż starsze</button>`;
    const had = el.querySelector('#h-q');
    if (!had) el.innerHTML = `<div class="hbar"><label class="hsearch">${SEARCH}<input id="h-q" type="search" placeholder="Szukaj posiłku lub składnika" autocomplete="off"></label></div><div class="hlist mlist"></div>`;
    const list = el.querySelector('.hlist');
    list.className = 'hlist mlist' + (animList ? ' enter' : '');
    list.innerHTML = html;
  }

  function periodStats(n) {
    const t = dayOnly(new Date()), days = [];
    for (let i = n - 1; i >= 0; i--) { const d = addDays(t, -i), k = key(d); days.push({ d, k, tot: dayTotals(k), n: mealsOn(k).length }); }
    const logged = days.filter(x => x.n);
    const avg = { kcal: 0, p: 0, f: 0, c: 0 };
    logged.forEach(x => ['kcal', 'p', 'f', 'c'].forEach(m => avg[m] += x.tot[m] / logged.length));
    const g = state.goals, inGoal = logged.filter(x => x.tot.kcal >= g.kcal * .9 && x.tot.kcal <= g.kcal * 1.1).length;
    let streak = 0; for (let i = days.length - 1; i >= 0; i--) { if (days[i].n) streak++; else if (i === days.length - 1) continue; else break; }
    return { days, logged, avg, inGoal, streak };
  }
  function renderSummary() {
    const el = $('view-summary'), g = state.goals, s = periodStats(sumDays), t = todayKey();
    const max = Math.max(g.kcal * 1.25, ...s.days.map(x => x.tot.kcal)) || 1;
    const m = sumDays > 7;
    const bars = s.days.map((x, j) => { const v = x.tot.kcal, cls = !x.n ? 'empty' : v > g.kcal * 1.1 ? 'over' : v < g.kcal * .8 ? 'low' : 'hit'; return `<div class="sb ${cls}" style="--j:${j}" title="${dateLabel(x.k)}: ${r0(v)} kcal"><span>${x.n ? (v >= 1000 ? (v / 1000).toLocaleString('pl-PL', { maximumFractionDigits: 1 }) + 'k' : r0(v)) : ''}</span><i style="height:${x.n ? v / max * 100 : 0}%"></i></div>`; }).join('');
    const lbls = s.days.map(x => `<span class="${x.k === t ? 't' : ''}">${m ? (x.d.getDate() % 5 === 0 || x.k === t ? x.d.getDate() : '') : DAYS[dow(x.d)]}</span>`).join('');
    const arc = (cls, label, v, goal) => { const len = Math.min(1, goal ? v / goal : 0) * 2 * Math.PI * 30; return `<div class="${cls}"><svg viewBox="0 0 76 76"><circle class="bg" cx="38" cy="38" r="30"/><circle class="fg" cx="38" cy="38" r="30" style="--len:${len.toFixed(1)}"/></svg><b>${r0(v)}<small style="font-size:10px"> g</small></b><small>${label} · ${Math.round(goal ? v / goal * 100 : 0)}%</small></div>`; };
    const top = new Map();
    Object.values(state.meals).filter(x => x.day > key(addDays(new Date(), -sumDays))).forEach(x => { const n = (x.name || '').trim(); if (n) top.set(n, (top.get(n) || 0) + 1); });
    const fav = [...top.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    el.innerHTML = `<div class="sbar"><div class="smode"><button data-sum="7" class="${sumDays === 7 ? 'on' : ''}">7 dni</button><button data-sum="30" class="${sumDays === 30 ? 'on' : ''}">30 dni</button></div></div>
      <div class="sgrid">
        <section class="scard${animList ? ' enter' : ''}" style="--i:0"><header><div><h3>Kalorie</h3><small>średnio <b>${r0(s.avg.kcal)}</b> kcal z dni z wpisami (${s.logged.length})</small></div><strong class="${s.logged.length ? (Math.abs(s.avg.kcal - g.kcal) <= g.kcal * .1 ? 'good' : s.avg.kcal > g.kcal ? 'bad' : 'mid') : ''}">${s.logged.length ? Math.round(s.avg.kcal / g.kcal * 100) + '%' : '—'}</strong></header>
          <div class="sbars${m ? ' m' : ''}" style="--n:${sumDays}">${bars}<div class="starget" style="bottom:${g.kcal / max * 100}%"><span>${nf(g.kcal)}</span></div></div><div class="sdays${m ? ' m' : ''}" style="--n:${sumDays}">${lbls}</div>
          <div class="schips" style="margin-top:4px"><span class="schip">W celu ±10%: ${s.inGoal}/${s.logged.length || 0}</span><span class="schip rec">Seria wpisów: ${s.streak} ${s.streak === 1 ? 'dzień' : 'dni'}</span></div></section>
        <section class="scard${animList ? ' enter' : ''}" style="--i:1"><header><div><h3>Makro średnio</h3><small>dziennie, względem celu</small></div></header><div class="avg">${arc('p', 'Białko', s.avg.p, g.p)}${arc('f', 'Tłuszcze', s.avg.f, g.f)}${arc('c', 'Węgle', s.avg.c, g.c)}</div></section>
        ${fav.length ? `<section class="scard${animList ? ' enter' : ''}" style="--i:2"><header><div><h3>Najczęściej</h3><small>posiłki w tym okresie</small></div></header><div class="schips" style="margin-top:0">${fav.map(([n, c]) => `<span class="schip">${esc(n)} · ${c}×</span>`).join('')}</div></section>` : ''}
      </div>`;
  }

  /* ---------- okienka ---------- */
  const sheet = (title, sub, body, label, cls = '') => `<div class="scrim" data-close><div class="sheet ${cls}" role="dialog" aria-modal="true" aria-label="${esc(label || title)}"><div class="sheet-h"><div><h2>${title}</h2>${sub ? `<small>${sub}</small>` : ''}</div><button class="x" data-close aria-label="Zamknij">×</button></div>${body}</div></div>`;
  let draft = null, scanJob = 0;
  const close = () => { overlay.innerHTML = ''; draft = null; scanJob++; };
  overlay.addEventListener('click', e => { if (e.target.hasAttribute('data-close')) close(); });

  // 1. wybór zdjęcia
  function openScan(type) {
    const k = key(selDay);
    overlay.innerHTML = sheet('Skanuj posiłek', view === 'day' && k !== todayKey() ? dateLabel(k) : 'Zdjęcie talerza → kalorie i makro', `
      <div class="pick"><label>${`<span class="bob">${CAM}</span>`}<span>Zrób zdjęcie</span><input type="file" accept="image/*" capture="environment" data-photo>${SEA_SVG}</label><label>${GALLERY}<span>Z galerii</span><input type="file" accept="image/*" data-photo>${SEA_SVG}</label></div>
      <div class="field"><label for="s-note">Podpowiedź dla AI <span style="color:var(--ink-3);font-weight:500">(opcjonalnie)</span></label><input id="s-note" type="text" maxlength="160" placeholder="np. 2 kromki, bez sosu, duża porcja" autocomplete="off"></div>
      <p class="hint">Najlepiej z góry, cały talerz w kadrze, przy dobrym świetle.</p>
      <button class="linkish" data-manual>Wpisz ręcznie</button>`, 'Skanuj posiłek');
    overlay.querySelectorAll('[data-photo]').forEach(inp => inp.addEventListener('change', () => { const f = inp.files?.[0]; if (f) runScan(f, $('s-note').value.trim(), type); }));
    overlay.querySelector('[data-manual]').addEventListener('click', () => openMealForm(newDraft(type)));
  }
  const newDraft = (type, extra = {}) => { const today = key(selDay) === todayKey() || view !== 'day'; const day = view === 'day' ? key(selDay) : todayKey(); return { id: null, day, at: today ? nowTime() : '12:00', type: type || typeByHour(today ? new Date().getHours() : 12), name: '', items: [{ n: '', g: 100, kcal: 0, p: 0, f: 0, c: 0 }], th: null, ai: false, ...extra }; };

  // Zmniejszenie zdjęcia na kanwie: do AI ~1024 px, miniatura do historii ~120 px.
  function shrink(file, max, q) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => {
        const s = Math.min(1, max / Math.max(img.width, img.height)), c = document.createElement('canvas');
        // miniatura: kwadrat ze środka
        if (max <= 200) { const side = Math.min(img.width, img.height); c.width = c.height = max; c.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, max, max); }
        else { c.width = Math.round(img.width * s); c.height = Math.round(img.height * s); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); }
        URL.revokeObjectURL(url); res(c.toDataURL('image/jpeg', q));
      };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Nie udało się wczytać zdjęcia')); };
      img.src = url;
    });
  }

  // 2. skanowanie: zdjęcie z sonarem, falą i bąbelkami, potem wynik od AI
  const MSGS = ['Zanurzam się w talerzu…', 'Rozpoznaję składniki…', 'Ważę porcje na oko…', 'Liczę białko, tłuszcze i węgle…', 'Wypływam z wynikiem…'];
  async function runScan(file, note, type) {
    const job = ++scanJob;
    let big, th;
    try { [big, th] = await Promise.all([shrink(file, 1024, .82), shrink(file, 120, .62)]); }
    catch (e) { toast(e.message); return; }
    if (job !== scanJob) return;
    overlay.innerHTML = sheet('Analizuję posiłek', note ? esc(note) : '', `<div class="scan" id="scan"><img src="${big}" alt=""><i class="corner a"></i><i class="corner b"></i><i class="corner c"></i><i class="corner d"></i><i class="sonar"></i><i class="sonar s2"></i><i class="sonar s3"></i><div class="sweep"></div><div class="tide">${SEA_SVG}</div></div><p class="scan-msg" id="scan-msg"><span>${MSGS[0]}</span></p><p class="scan-dots" style="text-align:center"><i></i><i></i><i></i></p><button class="linkish" data-close>Anuluj</button>`, 'Analiza posiłku');
    let mi = 0;
    const tide = overlay.querySelector('.tide');
    requestAnimationFrame(() => { if (tide) tide.style.height = '22%'; });
    const msgInt = setInterval(() => {
      if (job !== scanJob || !$('scan-msg')) { clearInterval(msgInt); return; }
      mi = Math.min(MSGS.length - 1, mi + 1);
      $('scan-msg').innerHTML = `<span>${MSGS[mi]}</span>`;
      if (tide) tide.style.height = (22 + mi * 12) + '%';
      const sc = $('scan'); if (sc) bubbles(sc, 6);
    }, 2200);
    try {
      const res = await window.Cloud.fn('meal-scan', { image: big.split(',')[1], mediaType: 'image/jpeg', note });
      clearInterval(msgInt);
      if (job !== scanJob) return;
      if (!res || !Array.isArray(res.items)) throw new Error('Pusta odpowiedź AI');
      const sc = $('scan'); if (sc) { sc.classList.add('done'); if (tide) tide.style.height = '100%'; bubbles(sc, 16); }
      const items = res.items.map(it => ({ n: String(it.name || '').slice(0, 80), g: r0(it.grams), kcal: r0(it.kcal), p: r1(it.protein), f: r1(it.fat), c: r1(it.carbs) }));
      const d = newDraft(type, { name: res.name || '', items: items.length ? items : [{ n: '', g: 100, kcal: 0, p: 0, f: 0, c: 0 }], th, big, ai: true, comment: res.comment || '', conf: res.confidence || '' });
      setTimeout(() => { if (job === scanJob) openMealForm(d); }, calm() ? 0 : 650);
      if (!items.length) toast(res.comment || 'Nie widzę jedzenia na zdjęciu');
    } catch (err) {
      clearInterval(msgInt);
      if (job !== scanJob) return;
      const msg = scanError(err);
      overlay.innerHTML = sheet('Nie udało się', '', `<div class="ai-note">${esc(msg)}</div><div class="confirm"><button data-retry>Spróbuj ponownie</button><button class="yes" style="background:var(--ink)" data-manual>Wpisz ręcznie</button></div>`, 'Błąd skanowania');
      overlay.querySelector('[data-retry]').addEventListener('click', () => runScan(file, note, type));
      overlay.querySelector('[data-manual]').addEventListener('click', () => openMealForm(newDraft(type, { th, big })));
    }
  }
  function scanError(err) {
    const m = (err?.message || '').toLowerCase();
    if (err instanceof TypeError || m.includes('failed to fetch')) return 'Brak połączenia z internetem (albo funkcja AI nie jest jeszcze włączona w Supabase).';
    if (err?.status === 404 || m.includes('not found')) return 'Funkcja AI „meal-scan” nie jest jeszcze wdrożona w Supabase — instrukcja jest w README.';
    if (err?.status === 429 || m.includes('limit')) return 'Dzisiejszy limit skanów się skończył — wpisz posiłek ręcznie albo spróbuj jutro.';
    if (err?.status === 401) return 'Sesja wygasła — zaloguj się ponownie.';
    if (err?.status === 402) return err.message;
    return 'AI nie odpowiedziało: ' + (err?.message || 'nieznany błąd');
  }

  // 3. wynik / edycja: składniki z gramaturą, sumy na żywo
  function openMealForm(d) {
    draft = JSON.parse(JSON.stringify(d));
    const editing = !!d.id;
    const photo = d.big || d.th;
    const body = `
      ${photo ? `<div class="ph-big"><img src="${esc(photo)}" alt="">${d.conf ? `<span class="conf">AI · pewność: ${{ high: 'wysoka', medium: 'średnia', low: 'niska' }[d.conf] || esc(d.conf)}</span>` : ''}${SEA_SVG}</div>` : ''}
      ${d.comment ? `<div class="ai-note"><b>AI:</b> ${esc(d.comment)}</div>` : ''}
      <div class="field"><label for="f-name">Nazwa</label><input id="f-name" type="text" maxlength="80" value="${esc(d.name)}" placeholder="np. Owsianka z bananem" autocomplete="off"></div>
      <div class="tot" id="f-tot"></div>
      <div class="field"><span class="lab">Składniki</span><div class="items" id="f-items"></div><button type="button" class="addit" id="f-add">+ Składnik</button></div>
      <div class="field"><span class="lab">Posiłek</span><div class="seg seg4">${TYPES.map(([v, l]) => `<label><input type="radio" name="f-type" value="${v}"${d.type === v ? ' checked' : ''}>${l}</label>`).join('')}</div></div>
      <div class="row-tm"><div class="field"><label for="f-day">Dzień</label><input id="f-day" type="date" value="${d.day}"></div><div class="field"><label for="f-at">Godzina</label><input id="f-at" type="time" value="${esc(d.at || '')}"></div></div>
      <div class="sheet-foot"><button class="primary" id="f-save">${editing ? 'Zapisz' : 'Dodaj do dnia'}</button>${editing ? `<button class="danger" id="f-del">Usuń</button>` : ''}</div>`;
    overlay.innerHTML = sheet(editing ? 'Posiłek' : d.ai ? 'Wynik skanu' : 'Nowy posiłek', editing ? dateLabel(d.day) : '', body, 'Posiłek', 'wide');
    drawItems(); drawTot(true);
    $('f-add').addEventListener('click', () => { draft.items.push({ n: '', g: 100, kcal: 0, p: 0, f: 0, c: 0 }); drawItems(draft.items.length - 1); drawTot(); });
    $('f-save').addEventListener('click', saveDraft);
    $('f-del')?.addEventListener('click', () => confirmDelete(draft.id));
    if (!editing && !d.ai) $('f-name').focus();
  }
  function drawItems(focus = -1) {
    const box = $('f-items'); if (!box) return;
    box.innerHTML = draft.items.map((it, i) => `<div class="it" data-i="${i}" style="--i:${focus >= 0 ? 0 : i}"><input data-k="n" type="text" value="${esc(it.n)}" placeholder="Składnik" aria-label="Składnik" autocomplete="off"><span class="gw"><input data-k="g" type="number" inputmode="decimal" min="0" value="${it.g || ''}" aria-label="Gramy"></span><button type="button" class="rm" data-rm="${i}" aria-label="Usuń składnik">${XMARK}</button>
      <div class="it-m">${[['kcal', 'kcal'], ['p', 'B'], ['f', 'T'], ['c', 'W']].map(([k, l]) => `<label>${l}<input data-k="${k}" type="number" inputmode="decimal" min="0" value="${it[k] || it[k] === 0 ? it[k] : ''}"></label>`).join('')}</div></div>`).join('');
    if (focus >= 0) box.querySelector(`[data-i="${focus}"] input`)?.focus();
  }
  function drawTot(first) {
    const box = $('f-tot'); if (!box) return;
    const t = totals(draft.items);
    if (first || !box.children.length) box.innerHTML = `<div><b data-cnt="t-kcal">0</b><small>kcal</small></div><div class="p"><b data-cnt="t-p">0</b><small>białko</small></div><div class="f"><b data-cnt="t-f">0</b><small>tłuszcz</small></div><div class="c"><b data-cnt="t-c">0</b><small>węgle</small></div>`;
    ['kcal', 'p', 'f', 'c'].forEach(k => {
      const el = box.querySelector(`[data-cnt="t-${k}"]`); if (first) shown.set('t-' + k, 0);
      if (shown.get('t-' + k) !== t[k] && !first) { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }
      countTo(el, t[k], first ? 900 : 300);
    });
  }
  overlay.addEventListener('input', e => {
    const row = e.target.closest('.it'); if (!row || !draft) return;
    const it = draft.items[+row.dataset.i], k = e.target.dataset.k; if (!it) return;
    if (k === 'n') { it.n = e.target.value; return; }
    const v = Math.max(0, parseFloat(String(e.target.value).replace(',', '.')) || 0);
    if (k === 'g') {
      // zmiana gramatury przelicza kalorie i makro proporcjonalnie
      const old = +it.g || 0;
      if (old > 0 && v > 0) { const s = v / old; ['kcal', 'p', 'f', 'c'].forEach(x => { it[x] = x === 'kcal' ? r0(it[x] * s) : r1(it[x] * s); const inp = row.querySelector(`[data-k="${x}"]`); if (inp) inp.value = it[x]; }); }
      it.g = v;
    } else it[k] = v;
    drawTot();
  });
  overlay.addEventListener('click', e => {
    const rm = e.target.closest('[data-rm]'); if (!rm || !draft) return;
    const i = +rm.dataset.rm, row = rm.closest('.it');
    const done = () => { draft.items.splice(i, 1); if (!draft.items.length) draft.items.push({ n: '', g: 100, kcal: 0, p: 0, f: 0, c: 0 }); drawItems(); drawTot(); };
    if (calm()) done(); else { row.classList.add('gone'); setTimeout(done, 300); }
  });
  function saveDraft() {
    const d = draft; if (!d) return;
    d.name = $('f-name').value.trim() || d.items.map(it => it.n.trim()).filter(Boolean).slice(0, 3).join(', ') || 'Posiłek';
    d.type = overlay.querySelector('input[name="f-type"]:checked')?.value || d.type;
    d.day = $('f-day').value || d.day; d.at = $('f-at').value || '';
    d.items = d.items.filter(it => it.n.trim() || it.kcal || it.p || it.f || it.c).map(it => ({ n: it.n.trim(), g: r0(it.g), kcal: r0(it.kcal), p: r1(it.p), f: r1(it.f), c: r1(it.c) }));
    if (!d.items.length) { toast('Dodaj co najmniej jeden składnik'); return; }
    const isNew = !d.id;
    const m = { id: d.id || uid(), day: d.day, at: d.at, type: d.type, name: d.name, items: d.items, th: d.th || null, ai: !!d.ai, created: d.created || Date.now() };
    state.meals[m.id] = m; save();
    close();
    if (isNew) { freshId = m.id; userAct = true; }
    else userAct = true;
    if (view !== 'day' || key(selDay) !== m.day) { view = 'day'; selDay = fromKey(m.day); animList = true; }
    render();
    toast(isNew ? `Dodano „${m.name}” · ${r0(totals(m.items).kcal)} kcal` : 'Zapisano');
  }
  function confirmDelete(id) {
    const m = state.meals[id]; if (!m) return;
    overlay.innerHTML = sheet('Usunąć posiłek?', esc(m.name), `<div class="confirm"><button data-close>Anuluj</button><button class="yes" id="confirm-del">Usuń</button></div>`);
    $('confirm-del').addEventListener('click', () => {
      close();
      const tile = document.querySelector(`[data-meal="${CSS.escape(id)}"]`);
      const go = () => { delete state.meals[id]; save(); userAct = true; render(); toast('Usunięto'); };
      if (!tile || calm()) { go(); return; }
      bubbles(tile, 10);
      tile.animate({ opacity: [1, 0], transform: ['none', 'translateY(24px) scale(.96)'] }, { duration: 380, easing: 'cubic-bezier(.5,0,.75,0)', fill: 'forwards' }).onfinish = go;
    });
  }
  // Ponowne dodanie posiłku z historii na dziś
  function logAgain(id) {
    const src = state.meals[id]; if (!src) return;
    const m = { ...JSON.parse(JSON.stringify(src)), id: uid(), day: todayKey(), at: nowTime(), type: typeByHour(new Date().getHours()), created: Date.now() };
    state.meals[m.id] = m; save();
    freshId = m.id; userAct = true; view = 'day'; selDay = dayOnly(new Date()); animList = true;
    try { localStorage.setItem('gmakro.view', view); } catch (_) { }
    render(); window.scrollTo({ top: 0 });
    toast(`Dodano na dziś: ${m.name}`);
  }

  // Cele: kalorie i gramy makro
  function openGoals() {
    const g = state.goals;
    overlay.innerHTML = sheet('Cele dzienne', 'Kalorie i makroskładniki', `
      <div class="goal-k"><button data-gk="-50" aria-label="Mniej">−</button><input id="g-kcal" type="number" inputmode="numeric" min="800" max="8000" step="50" value="${g.kcal}" aria-label="Kalorie"><button data-gk="50" aria-label="Więcej">+</button></div>
      <p class="hint" style="margin-top:-8px">kcal dziennie</p>
      <div class="split">${[['p', 'Białko', g.p], ['f', 'Tłuszcze', g.f], ['c', 'Węgle', g.c]].map(([k, l, v]) => `<div class="field ${k}"><label for="g-${k}"><i></i>${l}</label><input id="g-${k}" type="number" inputmode="numeric" min="0" value="${v}"></div>`).join('')}</div>
      <p class="split-sum" id="g-sum"></p>
      <div class="chips"><button data-preset="cut">Redukcja</button><button data-preset="keep">Utrzymanie</button><button data-preset="bulk">Masa</button></div>
      <button class="primary" id="g-save">Zapisz cele</button>`, 'Cele');
    const sum = () => { const p = +$('g-p').value || 0, f = +$('g-f').value || 0, c = +$('g-c').value || 0, k = +$('g-kcal').value || 0, m = p * 4 + f * 9 + c * 4; const el = $('g-sum'); el.textContent = `z makro: ${nf(m)} kcal (${k ? Math.round(m / k * 100) : 0}% celu)`; el.classList.toggle('bad', Math.abs(m - k) > k * .1); };
    overlay.querySelectorAll('[data-gk]').forEach(b => b.addEventListener('click', () => { $('g-kcal').value = Math.max(800, (+$('g-kcal').value || 0) + +b.dataset.gk); sum(); }));
    overlay.querySelectorAll('[data-preset]').forEach(b => b.addEventListener('click', () => {
      const k = +$('g-kcal').value || 2200, sp = { cut: [.35, .25, .40], keep: [.25, .30, .45], bulk: [.25, .25, .50] }[b.dataset.preset];
      $('g-p').value = Math.round(k * sp[0] / 4); $('g-f').value = Math.round(k * sp[1] / 9); $('g-c').value = Math.round(k * sp[2] / 4); sum();
    }));
    overlay.querySelectorAll('input').forEach(i => i.addEventListener('input', sum)); sum();
    $('g-save').addEventListener('click', () => {
      state.goals = { kcal: Math.max(800, +$('g-kcal').value || 2200), p: Math.max(0, +$('g-p').value || 0), f: Math.max(0, +$('g-f').value || 0), c: Math.max(0, +$('g-c').value || 0) };
      save(); close(); prevDayKey = null; render(); toast('Cele zapisane');
    });
  }

  /* ---------- ekran logowania: bez konta nie ma panelu ---------- */
  let authMode = 'in';
  function setAuthMode(m) {
    authMode = m;
    document.querySelectorAll('[data-auth]').forEach(b => b.setAttribute('aria-selected', b.dataset.auth === m));
    $('a-pass2-row').hidden = m !== 'up';
    $('a-pass').setAttribute('autocomplete', m === 'up' ? 'new-password' : 'current-password');
    $('a-submit').textContent = m === 'up' ? 'Załóż konto' : 'Zaloguj się';
    showAuthError('');
  }
  function showAuthError(msg) { const el = $('auth-err'); el.textContent = msg; el.hidden = !msg; }
  function updateGate() {
    const logged = !!window.Cloud?.user || !window.Cloud;
    $('auth').hidden = logged;
    $('app-main').hidden = !logged;
    if (!logged) { close(); if (!document.activeElement?.closest('#auth')) $('a-email').focus(); }
  }
  function authError(err) {
    const m = (err?.message || '').toLowerCase(), c = err?.code || '';
    if (err instanceof TypeError || m.includes('failed to fetch')) return 'Brak połączenia z internetem';
    if (err?.status === 429 || c === 'over_request_rate_limit' || m.includes('rate')) return 'Za dużo prób — spróbuj za kilka minut';
    if (c === 'invalid_credentials' || m.includes('invalid login')) return 'Zły e-mail lub hasło';
    if (c === 'user_already_exists' || m.includes('already registered')) return 'To konto już istnieje — zaloguj się';
    if (c === 'weak_password' || m.includes('password')) return 'Hasło musi mieć co najmniej 6 znaków';
    if (c === 'email_address_invalid' || m.includes('email')) return 'Sprawdź adres e-mail';
    return 'Nie udało się: ' + (err?.message || 'nieznany błąd');
  }
  document.querySelectorAll('[data-auth]').forEach(b => b.addEventListener('click', () => setAuthMode(b.dataset.auth)));
  $('auth-form').addEventListener('submit', async e => {
    e.preventDefault();
    const email = $('a-email').value.trim(), pass = $('a-pass').value, pass2 = $('a-pass2').value;
    if (!/^\S+@\S+\.\S+$/.test(email)) return showAuthError('Sprawdź adres e-mail');
    if (pass.length < 6) return showAuthError('Hasło musi mieć co najmniej 6 znaków');
    if (authMode === 'up' && pass !== pass2) return showAuthError('Hasła nie są takie same');
    const btn = $('a-submit'), label = btn.textContent;
    btn.disabled = true; btn.textContent = '…'; showAuthError('');
    try {
      if (authMode === 'up') await window.Cloud.signUp(email, pass); else await window.Cloud.signIn(email, pass);
      try { if (window.PasswordCredential) await navigator.credentials.store(new PasswordCredential({ id: email, password: pass, name: email })); } catch (_) { }
      hello = true; updateGate(); render();
      setTimeout(() => { $('auth-form').reset(); setAuthMode('in'); }, 1500);
    } catch (err) { showAuthError(authError(err)); }
    finally { btn.disabled = false; btn.textContent = label === '…' ? 'Zaloguj się' : label; }
  });
  // Komputer: ⋯ = konto, cele, wylogowanie. Telefon: ☰ = widoki, cele, wylogowanie.
  $('menu-btn').addEventListener('click', () => {
    if (isMobile()) {
      const item = (v, label) => `<button class="nav-item${view === v ? ' on' : ''}" data-go-view="${v}">${label}</button>`;
      overlay.innerHTML = sheet('Menu', esc(window.Cloud?.user?.email || ''), `<nav class="navmenu">${item('day', 'Dzień')}${item('history', 'Historia')}${item('summary', 'Podsumowanie')}<button class="nav-item" data-goals>Cele</button><button class="nav-item out" id="logout">Wyloguj się</button></nav>`, 'Menu');
      overlay.querySelectorAll('[data-go-view]').forEach(b => b.addEventListener('click', () => { close(); setView(b.dataset.goView); window.scrollTo({ top: 0 }); }));
    } else {
      overlay.innerHTML = sheet(esc(window.Cloud?.user?.email || 'Konto'), '', `<button class="nav-item" data-goals>Cele dzienne</button><button class="primary" id="logout">Wyloguj</button>`, 'Konto');
    }
    overlay.querySelector('[data-goals]').addEventListener('click', openGoals);
    $('logout').addEventListener('click', confirmLogout);
  });
  function confirmLogout() {
    overlay.innerHTML = sheet('Czy chcesz się wylogować?', '', `<div class="confirm"><button data-close>Nie</button><button class="yes" id="confirm-logout">Tak</button></div>`);
    $('confirm-logout').addEventListener('click', async () => {
      const b = $('confirm-logout'); b.disabled = true;
      try { await window.Cloud.signOut(); close(); applyState({ meals: {} }); updateGate(); }
      catch (err) { close(); toast(err.message); }
    });
  }

  /* ---------- zdarzenia ---------- */
  let userAct = false;
  function setView(v) { view = v; animList = true; try { localStorage.setItem('gmakro.view', view); } catch (_) { } render(); }
  function step(dir) { if (view !== 'day') return; selDay = addDays(selDay, dir); slideDir = dir; render(); }
  document.addEventListener('click', e => {
    if (e.target.closest('#overlay')) return;
    const ag = e.target.closest('[data-again]'); if (ag) { e.stopPropagation(); logAgain(ag.dataset.again); return; }
    const ml = e.target.closest('[data-meal]');
    if (ml) {
      const m = state.meals[ml.dataset.meal]; if (!m) return;
      if (!calm()) { ml.animate({ transform: ['scale(1)', 'scale(1.025)', 'scale(1)'] }, { duration: 320, easing: 'cubic-bezier(.3,.7,.4,1)' }); ripple(e.clientX, e.clientY, 1); }
      setTimeout(() => openMealForm(m), calm() ? 0 : 140); return;
    }
    if (e.target.closest('#add-meal') || e.target.closest('[data-scan]')) { openScan(); return; }
    const at = e.target.closest('[data-add-type]'); if (at) { openScan(at.dataset.addType); return; }
    const vt = e.target.closest('.vtab[data-view]'); if (vt) { if (e.clientX || e.clientY) ripple(e.clientX, e.clientY, .7); setView(vt.dataset.view); return; }
    const nav = e.target.closest('[data-nav]'); if (nav) { step(+nav.dataset.nav); return; }
    if (e.target.closest('#go-today, [data-today]')) { if (key(selDay) === todayKey()) return; slideDir = selDay > new Date() ? -1 : 1; selDay = dayOnly(new Date()); render(); return; }
    const sm = e.target.closest('[data-sum]'); if (sm) { sumDays = +sm.dataset.sum; animList = true; render(); return; }
    if (e.target.closest('[data-more]')) { hLimit += 14; render(); return; }
    const gd = e.target.closest('[data-goday]'); if (gd) { selDay = fromKey(gd.dataset.goday); setView('day'); window.scrollTo({ top: 0 }); return; }
    const ring = e.target.closest('.ring'); if (ring && !calm()) { ripple(e.clientX, e.clientY, 1.4); bubbles(ring, 8); }
  });
  document.addEventListener('input', e => { if (e.target.id === 'h-q') { hQuery = e.target.value; hLimit = 14; renderHistory(); } });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlay.innerHTML) { close(); return; }
    if (e.key === 'Enter' && e.target.matches('#overlay .it input')) { e.preventDefault(); e.target.blur(); return; }
    if (overlay.innerHTML || e.target.matches('input')) return;
    if (e.key === 'ArrowLeft') step(-1);
    if (e.key === 'ArrowRight') step(1);
  });
  // telefon: przesunięcie palcem w bok zmienia dzień
  let sw = null;
  $('view-day').addEventListener('pointerdown', e => { if (e.pointerType === 'touch') sw = { x: e.clientX, y: e.clientY, pid: e.pointerId }; });
  $('view-day').addEventListener('pointerup', e => {
    if (!sw || e.pointerId !== sw.pid) return;
    const dx = e.clientX - sw.x, dy = e.clientY - sw.y; sw = null;
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.6) step(dx < 0 ? 1 : -1);
  });
  $('view-day').addEventListener('pointercancel', () => { sw = null; });
  // nowy dzień: po północy „dziś” przeskakuje samo
  let lastToday = todayKey();
  function checkDayChange() { const t = todayKey(); if (t === lastToday) return false; const wasToday = key(selDay) === lastToday; lastToday = t; if (wasToday) selDay = dayOnly(new Date()); render(); return true; }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkDayChange(); });
  setInterval(checkDayChange, 60000);

  let tt;
  function toast(m) {
    let el = document.querySelector('.toast');
    if (!el) { el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
    el.textContent = m; el.hidden = false; el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
    clearTimeout(tt); tt = setTimeout(() => el.hidden = true, 2600);
  }

  /* ---------- morskie efekty: bąbelki, kręgi na wodzie, fala przez cały ekran, morze w tle ---------- */
  const sea = document.createElement('div');
  sea.className = 'sea'; sea.setAttribute('aria-hidden', 'true'); sea.innerHTML = SEA_SVG;
  document.body.appendChild(sea);
  const bed = document.createElement('div');
  bed.className = 'seabed'; bed.setAttribute('aria-hidden', 'true'); bed.innerHTML = SEA_SVG;
  document.body.appendChild(bed);
  function bubbles(el, n = 11) {
    if (calm()) return;
    const r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    for (let i = 0; i < n; i++) {
      const s = 4 + Math.random() * 7, dx = (Math.random() - .5) * Math.min(r.width, 220) * 1.2, rise = 36 + Math.random() * 70, sway = (Math.random() - .5) * 18;
      const b = document.createElement('i');
      b.className = 'bubble';
      Object.assign(b.style, { left: cx - s / 2 + 'px', top: cy - s / 2 + 'px', width: s + 'px', height: s + 'px' });
      document.body.appendChild(b);
      b.animate([
        { transform: 'translate(0,0) scale(.3)', opacity: 0 },
        { transform: `translate(${dx * .4}px,${-rise * .3}px) scale(1)`, opacity: 1, offset: .2 },
        { transform: `translate(${dx * .7 + sway}px,${-rise * .7}px) scale(1)`, opacity: .9, offset: .7 },
        { transform: `translate(${dx}px,${-rise}px) scale(1.5)`, opacity: 0 }
      ], { duration: 700 + Math.random() * 500, delay: Math.random() * 120, easing: 'cubic-bezier(.3,.6,.4,1)', fill: 'backwards' }).onfinish = () => b.remove();
      setTimeout(() => b.remove(), 1700);
    }
  }
  function ripple(x, y, k = 1) {
    if (calm() || (!x && !y)) return;
    [0, 140].forEach(delay => {
      const r = document.createElement('i');
      r.className = 'ripple';
      Object.assign(r.style, { left: x + 'px', top: y + 'px' });
      document.body.appendChild(r);
      r.animate({ transform: ['translate(-50%,-50%) scale(.1)', `translate(-50%,-50%) scale(${k})`], opacity: [.55, 0] },
        { duration: 650, delay, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'backwards' }).onfinish = () => r.remove();
      setTimeout(() => r.remove(), 1000);
    });
  }
  function swell() {
    if (calm()) return;
    sea.classList.remove('swell'); void sea.offsetWidth; sea.classList.add('swell');
    setTimeout(() => sea.classList.remove('swell'), 2700);
    for (let i = 0; i < 26; i++) {
      const s = 5 + Math.random() * 10, x = Math.random() * innerWidth;
      const b = document.createElement('i');
      b.className = 'bubble';
      Object.assign(b.style, { left: x + 'px', top: innerHeight - 10 + 'px', width: s + 'px', height: s + 'px' });
      document.body.appendChild(b);
      const rise = innerHeight * (.3 + Math.random() * .45), sw = (Math.random() - .5) * 60;
      b.animate([
        { transform: 'translate(0,0)', opacity: 0 },
        { transform: `translate(${sw * .5}px,${-rise * .4}px)`, opacity: .9, offset: .3 },
        { transform: `translate(${sw}px,${-rise}px) scale(1.4)`, opacity: 0 }
      ], { duration: 1400 + Math.random() * 900, delay: Math.random() * 500, easing: 'ease-out', fill: 'backwards' }).onfinish = () => b.remove();
      setTimeout(() => b.remove(), 3200);
    }
  }
  // Cel kalorii na dziś osiągnięty: niebieska fala przez ekran i podskok liczby.
  function celebrate() {
    navigator.vibrate?.([15, 60, 25]);
    toast('Cel kalorii na dziś osiągnięty');
    if (calm()) return;
    document.querySelector('#view-day .ring')?.animate({ transform: ['scale(1)', 'scale(1.08)', 'scale(.98)', 'scale(1)'] }, { duration: 900, easing: 'ease-out' });
    swell();
  }
  // Morze w tle: co kilka sekund z dna wypływa pojedynczy bąbelek.
  function ambient() {
    if (calm() || document.hidden || overlay.innerHTML) return;
    const s = 4 + Math.random() * 9, x = Math.random() * innerWidth;
    const b = document.createElement('i');
    b.className = 'amb';
    Object.assign(b.style, { left: x + 'px', top: innerHeight + 'px', width: s + 'px', height: s + 'px' });
    document.body.appendChild(b);
    const rise = innerHeight * (.5 + Math.random() * .5), sway = (Math.random() - .5) * 80;
    b.animate([
      { transform: 'translate(0,0)', opacity: 0 },
      { transform: `translate(${sway * .3}px,${-rise * .25}px)`, opacity: .7, offset: .15 },
      { transform: `translate(${-sway * .4}px,${-rise * .6}px)`, opacity: .55, offset: .6 },
      { transform: `translate(${sway}px,${-rise}px) scale(1.3)`, opacity: 0 }
    ], { duration: 7000 + Math.random() * 5000, easing: 'linear' }).onfinish = () => b.remove();
    setTimeout(() => b.remove(), 13000);
  }
  setInterval(ambient, 2600);

  /* ---------- telefon: bez przybliżania ---------- */
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(t => document.addEventListener(t, e => e.preventDefault(), { passive: false }));
  document.addEventListener('touchmove', e => { if (e.touches.length > 1 || (e.scale && e.scale !== 1)) e.preventDefault(); }, { passive: false });

  /* ---------- PWA ---------- */
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => { }));
  }

  render();

  /* ---------- konto i synchronizacja (js/cloud.js) ---------- */
  updateGate();
  if (window.Cloud) {
    let wasLogged = !!window.Cloud.user;
    window.Cloud.onChange(() => { const now = !!window.Cloud.user; if (now !== wasLogged) { wasLogged = now; updateGate(); } });
    window.Cloud.attach({ getState: () => state, applyState });
  }
})();
