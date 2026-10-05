/* Foodcker — konto i synchronizacja z Supabase na żywo (logowanie e-mailem i hasłem, Realtime) oraz skanowanie posiłków przez AI.
   Bez zewnętrznych bibliotek: Supabase Auth (GoTrue), REST (PostgREST) i Edge Functions przez fetch.

   Model synchronizacji (jak w Grochu's tracker): stan aplikacji jest spłaszczany do elementów (cele, posiłek).
   Każdy element ma znacznik czasu ostatniej zmiany; przy łączeniu wygrywa nowszy (także usunięcia).
   W chmurze jest jeden wiersz na użytkownika: tabela makro_data (user_id, data jsonb, updated_at). */
(() => {
  'use strict';

  const SUPABASE_URL = 'https://xumjkmfctdutouvfgzsh.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_EPRQnKETbD-CYt_TXALc8Q_v_PoC0yK'; // klucz publiczny (przeglądarkowy)
  const AUTH_KEY = 'gmakro.auth';
  const META_KEY = 'gmakro.sync';

  /* ---------- pamięć lokalna ---------- */
  const read = k => { try { return JSON.parse(localStorage.getItem(k)); } catch (_) { return null; } };
  const write = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch (_) { } };

  /* ---------- spłaszczanie stanu ---------- */
  // Elementy: 'g' = cele (kcal i makro), 'm:<id>' = posiłek (z miniaturą zdjęcia).
  function flatten(s) {
    const items = { g: s.goals };
    Object.values(s.meals || {}).forEach(m => { items['m:' + m.id] = m; });
    return items;
  }
  function unflatten(items) {
    const meals = {};
    Object.keys(items).forEach(k => { if (k.startsWith('m:')) meals[k.slice(2)] = items[k]; });
    return { goals: items.g, meals };
  }
  // Porównanie niezależne od kolejności kluczy (inaczej te same dane uchodziły za różne i synchronizacja kręciła się w kółko).
  const canon = v => Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v;
  const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

  // Łączenie dwóch dokumentów {items, ts}: dla każdego klucza wygrywa nowszy znacznik (remis → chmura).
  function merge(local, remote) {
    const items = {}, ts = {};
    const keys = new Set([...Object.keys(local.ts), ...Object.keys(remote.ts), ...Object.keys(local.items), ...Object.keys(remote.items)]);
    keys.forEach(k => {
      const lt = local.ts[k] || 0, rt = remote.ts[k] || 0;
      const src = lt > rt ? local : remote;
      ts[k] = Math.max(lt, rt);
      if (k in src.items) items[k] = src.items[k];
    });
    return { items, ts };
  }

  /* ---------- sieć ---------- */
  async function api(path, { method = 'GET', body, token, headers = {} } = {}) {
    const res = await fetch(SUPABASE_URL + path, {
      method,
      headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers },
      body: body == null ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) { }
    if (!res.ok) { const err = new Error(json?.msg || json?.message || json?.error_description || json?.error || `HTTP ${res.status}`); err.status = res.status; err.code = json?.error_code || json?.code; throw err; }
    return json;
  }

  /* ---------- sesja ---------- */
  let session = read(AUTH_KEY);
  const saveSession = s => {
    session = s && { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at || Math.floor(Date.now() / 1000) + (s.expires_in || 3600), user_id: s.user?.id || session?.user_id, email: s.user?.email || session?.email };
    write(AUTH_KEY, session);
  };
  // Sesja zostaje na urządzeniu na stałe; token odświeża się sam. Wylogowanie tylko, gdy Supabase jednoznacznie
  // odrzuci sesję (np. usunięte konto) — nigdy przy braku internetu, limicie zapytań czy błędzie serwera.
  const SESSION_DEAD = /refresh_token_not_found|refresh_token_already_used|session_not_found|session_expired|user_not_found|invalid refresh token/i;
  let refreshing = null;
  async function token() {
    if (!session) throw Object.assign(new Error('Niezalogowany'), { status: 401 });
    if (session.expires_at - 60 > Date.now() / 1000) return session.access_token;
    if (!refreshing) {
      const rt = session.refresh_token;
      refreshing = (async () => {
        try {
          saveSession(await api('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: rt } }));
          wsSend({ topic: 'realtime:gmakro', event: 'access_token', payload: { access_token: session.access_token } });
        } catch (e) {
          if ((e.status === 400 || e.status === 401) && SESSION_DEAD.test(`${e.code} ${e.message}`) && session?.refresh_token === rt) { saveSession(null); emit(); }
          throw e;
        } finally { refreshing = null; }
      })();
    }
    await refreshing;
    return session.access_token;
  }

  /* ---------- połączenie z aplikacją ---------- */
  let app = null;               // { getState, applyState }
  let status = 'idle';          // idle | syncing | ok | offline | error
  let lastSync = null, lastError = '';
  const listeners = new Set();
  const emit = () => listeners.forEach(f => f());

  function meta() { return read(META_KEY) || { flat: null, ts: {}, dirty: false }; }
  // Wywoływane po każdym lokalnym zapisie: znajduje zmienione elementy i nadaje im znacznik czasu.
  function trackLocal() {
    const m = meta(), flat = flatten(app.getState()), now = Date.now();
    if (!m.flat) { // pierwsze uruchomienie: istniejące dane dostają stary znacznik (przy łączeniu nic nie ginie, remis → chmura)
      Object.keys(flat).forEach(k => { m.ts[k] = 1; });
    } else {
      new Set([...Object.keys(m.flat), ...Object.keys(flat)]).forEach(k => { if (!same(m.flat[k], flat[k])) { m.ts[k] = now; m.dirty = true; } });
    }
    m.flat = flat;
    write(META_KEY, m);
  }

  let timer = null, running = null, localVersion = 0;
  function schedule(ms = 300) { clearTimeout(timer); if (session) timer = setTimeout(sync, ms); }

  /* ---------- na żywo: Supabase Realtime (WebSocket, protokół Phoenix) ----------
     Serwer powiadamia o każdej zmianie wiersza użytkownika w makro_data → od razu pobieramy zmiany.
     Wymaga: alter publication supabase_realtime add table public.makro_data; (RLS dalej obowiązuje). */
  const TOPIC = 'realtime:gmakro';
  let ws = null, hb = null, wsRef = 0, wsRetry = 0, wsTimer = null;
  const wsSend = m => { if (ws?.readyState === 1) ws.send(JSON.stringify({ ...m, ref: String(++wsRef) })); };
  function rtConnect() {
    if (!session || ws || !('WebSocket' in window)) return;
    clearTimeout(wsTimer);
    let sock;
    try { sock = new WebSocket(`${SUPABASE_URL.replace(/^http/, 'ws')}/realtime/v1/websocket?apikey=${encodeURIComponent(SUPABASE_KEY)}&vsn=1.0.0`); }
    catch (_) { return rtRetry(); }
    ws = sock;
    sock.onopen = async () => {
      let tok; try { tok = await token(); } catch (_) { sock.close(); return; }
      sock.send(JSON.stringify({
        topic: TOPIC, event: 'phx_join', ref: String(++wsRef), join_ref: '1',
        payload: { access_token: tok, config: { broadcast: { self: false }, presence: { key: '' }, private: false,
          postgres_changes: [{ event: '*', schema: 'public', table: 'makro_data', filter: `user_id=eq.${session.user_id}` }] } },
      }));
      clearInterval(hb);
      hb = setInterval(() => wsSend({ topic: 'phoenix', event: 'heartbeat', payload: {} }), 25000);
    };
    sock.onmessage = e => {
      let m; try { m = JSON.parse(e.data); } catch (_) { return; }
      if (m.topic !== TOPIC) return;
      if (m.event === 'postgres_changes') schedule(0);                                   // zmiana z innego urządzenia
      else if (m.event === 'phx_reply' && m.payload?.status === 'ok') { wsRetry = 0; schedule(0); } // (ponowne) połączenie: dociągnij to, co mogło umknąć
      else if (m.event === 'phx_error' || m.event === 'phx_close') sock.close();
    };
    sock.onclose = () => { clearInterval(hb); if (ws === sock) { ws = null; rtRetry(); } };
    sock.onerror = () => { try { sock.close(); } catch (_) { } };
  }
  function rtRetry() {
    if (!session) return;
    clearTimeout(wsTimer);
    wsTimer = setTimeout(rtConnect, Math.min(30000, 1000 * 2 ** wsRetry++));
  }
  function rtClose() {
    clearTimeout(wsTimer); clearInterval(hb);
    if (ws) { const s = ws; ws = null; s.onclose = null; try { s.close(); } catch (_) { } }
  }

  async function sync() {
    if (!session || !app) return;
    if (running) return running.then(() => sync());
    running = (async () => {
      status = 'syncing'; emit();
      try {
        const tok = await token();
        const rows = await api('/rest/v1/makro_data?select=data', { token: tok });
        const remote = rows?.[0]?.data?.items ? rows[0].data : { items: {}, ts: {} };
        // Stan lokalny czytamy dopiero PO pobraniu z chmury, żeby objąć kliknięcia z czasu pobierania.
        trackLocal();
        const m = meta();
        const local = { items: m.flat, ts: m.ts };
        const merged = merge(local, remote);
        if (!same(merged.items, local.items)) {
          app.applyState(unflatten(merged.items)); // nadpisuje stan aplikacji bez oznaczania zmian jako lokalnych
        }
        const needPush = !same(merged, remote);
        write(META_KEY, { flat: merged.items, ts: merged.ts, dirty: needPush });
        const v = localVersion;
        if (needPush) {
          await api('/rest/v1/makro_data?on_conflict=user_id', {
            method: 'POST', token: tok,
            headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
            body: { user_id: session.user_id, data: merged, updated_at: new Date().toISOString() },
          });
        }
        // Zmiany zrobione w trakcie wysyłki zostały już zapisane w META przez changed() — nie nadpisujemy ich, tylko dosyłamy.
        if (localVersion === v) write(META_KEY, { ...meta(), dirty: false }); else schedule(0);
        status = 'ok'; lastSync = new Date(); lastError = '';
      } catch (e) {
        status = navigator.onLine === false || e instanceof TypeError ? 'offline' : 'error';
        lastError = e.message || String(e);
      } finally { running = null; emit(); }
    })();
    return running;
  }

  /* ---------- API dla aplikacji ---------- */
  window.Cloud = {
    get user() { return session ? { email: session.email, id: session.user_id } : null; },
    get status() { return status; },
    get lastSync() { return lastSync; },
    get lastError() { return lastError; },
    get dirty() { return !!meta().dirty; },
    onChange(f) { listeners.add(f); return () => listeners.delete(f); },

    attach(a) {
      app = a;
      if (!read(META_KEY)) trackLocal();
      navigator.storage?.persist?.().catch(() => { }); // prośba, żeby system nie czyścił danych i sesji
      if (session) { sync(); rtConnect(); }
      window.addEventListener('online', () => { schedule(0); rtConnect(); });
      document.addEventListener('visibilitychange', () => { if (!document.hidden) { schedule(0); rtConnect(); } });
      setInterval(() => { if (!document.hidden) schedule(0); }, 20000); // zapas, gdyby połączenie na żywo nie działało
    },
    // po każdym lokalnym zapisie
    changed() { if (!app) return; localVersion++; trackLocal(); schedule(); },

    // Logowanie e-mailem i hasłem (potwierdzanie maila jest wyłączone w Supabase, więc konto działa od razu).
    async signIn(email, password) {
      saveSession(await api('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } })); emit();
      await sync(); rtConnect();
    },
    async signUp(email, password) {
      const s = await api('/auth/v1/signup', { method: 'POST', body: { email, password } });
      if (!s?.access_token) throw Object.assign(new Error('Konto utworzone, ale wymaga potwierdzenia e-mailem'), { code: 'needs_confirm' });
      saveSession(s); emit();
      await sync(); rtConnect();
    },
    // Wylogowanie: najpierw wysyła zmiany; jeśli się nie da, nie wylogowuje (żeby nic nie zginęło).
    async signOut() {
      if (!session) return;
      await sync();
      if (status !== 'ok') throw new Error('Brak połączenia — najpierw trzeba wysłać zmiany do chmury.');
      try { await api('/auth/v1/logout', { method: 'POST', token: session.access_token }); } catch (_) { }
      rtClose();
      saveSession(null); write(META_KEY, null);
      status = 'idle'; lastSync = null; emit();
    },
    syncNow: () => sync(),

    // Wywołanie funkcji serwerowej Supabase (np. meal-scan — analiza zdjęcia posiłku przez AI).
    async fn(name, body) {
      return api('/functions/v1/' + name, { method: 'POST', token: await token(), body });
    },
  };
})();
