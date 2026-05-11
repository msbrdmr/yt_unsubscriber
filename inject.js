(() => {
  if (window.__ytu) return;

  const ORIGIN = 'https://www.youtube.com';

  async function sha1Hex(str) {
    const buf = new TextEncoder().encode(str);
    const hash = await crypto.subtle.digest('SHA-1', buf);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function getCookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[-.]/g, '\\$&') + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  async function authHeader() {
    const sapisid =
      getCookie('SAPISID') ||
      getCookie('__Secure-3PAPISID') ||
      getCookie('__Secure-1PAPISID');
    if (!sapisid) throw new Error('No SAPISID cookie. Make sure you are signed in to youtube.com.');
    const ts = Math.floor(Date.now() / 1000);
    const hex = await sha1Hex(`${ts} ${sapisid} ${ORIGIN}`);
    return `SAPISIDHASH ${ts}_${hex}`;
  }

  function cfg(name) {
    if (window.ytcfg?.get) {
      try { return window.ytcfg.get(name); } catch { /* noop */ }
    }
    return window.ytcfg?.data_?.[name];
  }

  async function ytFetch(endpoint, body) {
    const ctx = cfg('INNERTUBE_CONTEXT');
    if (!ctx) throw new Error('INNERTUBE_CONTEXT unavailable — load youtube.com first.');
    const auth = await authHeader();
    const url = `${ORIGIN}/youtubei/v1/${endpoint}?prettyPrint=false`;
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': auth,
        'X-Origin': ORIGIN,
        'X-Goog-AuthUser': String(cfg('SESSION_INDEX') ?? 0),
        'X-YouTube-Client-Name': String(cfg('INNERTUBE_CONTEXT_CLIENT_NAME') ?? 1),
        'X-YouTube-Client-Version': String(cfg('INNERTUBE_CONTEXT_CLIENT_VERSION') ?? ctx.client?.clientVersion ?? ''),
      },
      body: JSON.stringify({ context: ctx, ...body }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 240)}`);
    }
    return res.json();
  }

  function walk(node, fn) {
    if (!node || typeof node !== 'object') return;
    if (fn(node) === true) return;
    if (Array.isArray(node)) {
      for (const v of node) walk(v, fn);
    } else {
      for (const k in node) walk(node[k], fn);
    }
  }

  function findUnsubCmd(root) {
    let out = null;
    walk(root, n => {
      if (out) return true;
      const ep = n.unsubscribeEndpoint;
      if (ep && Array.isArray(ep.channelIds)) {
        out = { channelIds: ep.channelIds.slice(), params: ep.params || null };
        return true;
      }
    });
    return out;
  }

  function titleOf(t) {
    if (!t) return '';
    if (typeof t === 'string') return t;
    if (t.simpleText) return t.simpleText;
    if (Array.isArray(t.runs)) return t.runs.map(r => r.text || '').join('');
    return '';
  }

  function extractChannels(data) {
    const found = new Map();
    walk(data, n => {
      const cr = n.channelRenderer || n.gridChannelRenderer;
      if (!cr || !cr.channelId) return;
      const subBtn = cr.subscribeButton?.subscribeButtonRenderer;
      if (subBtn && subBtn.subscribed === false) return;
      if (found.has(cr.channelId)) return;
      const unsubCmd = findUnsubCmd(cr);
      found.set(cr.channelId, {
        id: cr.channelId,
        title: titleOf(cr.title),
        handle: cr.subscriberCountText?.simpleText || '',
        unsubCmd,
      });
    });
    return [...found.values()];
  }

  function findContinuationToken(data) {
    let token = null;
    walk(data, n => {
      if (token) return true;
      const cc = n.continuationCommand?.token;
      if (cc) { token = cc; return true; }
      const reload = n.reloadContinuationData?.continuation;
      if (reload) { token = reload; return true; }
    });
    return token;
  }

  const state = {
    subscriptions: [],
    fetching: false,
    fetchDone: false,
    fetchError: null,
    fetchPages: 0,
    unsubscribing: false,
    unsubDone: 0,
    unsubTotal: 0,
    unsubFailures: [],
    cancelRequested: false,
    lastUpdate: Date.now(),
  };

  function touch() { state.lastUpdate = Date.now(); }

  async function fetchAll() {
    if (state.fetching) return { busy: true };
    state.fetching = true;
    state.fetchDone = false;
    state.fetchError = null;
    state.subscriptions = [];
    state.fetchPages = 0;
    state.cancelRequested = false;
    touch();

    const seen = new Map();
    const merge = arr => {
      for (const c of arr) if (!seen.has(c.id)) seen.set(c.id, c);
      state.subscriptions = [...seen.values()];
      touch();
    };

    try {
      let response = await ytFetch('browse', { browseId: 'FEchannels' });
      state.fetchPages++;
      merge(extractChannels(response));

      let token = findContinuationToken(response);
      let safety = 500;
      let lastTokenSnapshot = null;
      while (token && !state.cancelRequested && safety-- > 0) {
        if (token === lastTokenSnapshot) break;
        lastTokenSnapshot = token;
        const before = seen.size;
        response = await ytFetch('browse', { continuation: token });
        state.fetchPages++;
        merge(extractChannels(response));
        const next = findContinuationToken(response);
        if (!next) break;
        if (next === token && seen.size === before) break;
        token = next;
      }
      state.fetchDone = true;
    } catch (e) {
      state.fetchError = e.message || String(e);
    } finally {
      state.fetching = false;
      touch();
    }
    return { count: state.subscriptions.length, error: state.fetchError };
  }

  async function unsubscribeOne(item) {
    const body = item.unsubCmd
      ? { channelIds: item.unsubCmd.channelIds, ...(item.unsubCmd.params ? { params: item.unsubCmd.params } : {}) }
      : { channelIds: [item.id] };
    const res = await ytFetch('subscription/unsubscribe', body);
    // Some responses report success via actions array; we treat HTTP 200 as success.
    return res;
  }

  async function unsubscribeAll(opts = {}) {
    if (state.unsubscribing) return { busy: true };
    const concurrency = Math.max(1, Math.min(32, opts.concurrency || 8));
    const onlySet = Array.isArray(opts.only) && opts.only.length ? new Set(opts.only) : null;
    const items = (onlySet ? state.subscriptions.filter(s => onlySet.has(s.id)) : state.subscriptions.slice());

    state.unsubscribing = true;
    state.unsubDone = 0;
    state.unsubTotal = items.length;
    state.unsubFailures = [];
    state.cancelRequested = false;
    touch();

    let idx = 0;
    const workers = Array.from({ length: concurrency }, async () => {
      while (!state.cancelRequested) {
        const i = idx++;
        if (i >= items.length) return;
        const item = items[i];
        let attempt = 0;
        while (true) {
          try {
            await unsubscribeOne(item);
            break;
          } catch (e) {
            attempt++;
            if (attempt >= 3) {
              state.unsubFailures.push({ id: item.id, title: item.title, error: e.message || String(e) });
              break;
            }
            await new Promise(r => setTimeout(r, 200 * attempt + Math.random() * 200));
          }
        }
        state.unsubDone++;
        touch();
      }
    });
    await Promise.all(workers);
    state.unsubscribing = false;
    touch();

    // Remove successfully-unsubscribed items from subscriptions list.
    const failedIds = new Set(state.unsubFailures.map(f => f.id));
    state.subscriptions = state.subscriptions.filter(s => !items.includes(s) || failedIds.has(s.id));
    touch();

    return { done: state.unsubDone, failures: state.unsubFailures.length };
  }

  function cancel() {
    state.cancelRequested = true;
    touch();
  }

  function getState() {
    return {
      subscriptions: state.subscriptions.map(s => ({ id: s.id, title: s.title })),
      fetching: state.fetching,
      fetchDone: state.fetchDone,
      fetchError: state.fetchError,
      fetchPages: state.fetchPages,
      unsubscribing: state.unsubscribing,
      unsubDone: state.unsubDone,
      unsubTotal: state.unsubTotal,
      unsubFailureCount: state.unsubFailures.length,
      unsubFailuresSample: state.unsubFailures.slice(0, 10),
      lastUpdate: state.lastUpdate,
    };
  }

  function reset() {
    state.subscriptions = [];
    state.fetchDone = false;
    state.fetchError = null;
    state.fetchPages = 0;
    state.unsubDone = 0;
    state.unsubTotal = 0;
    state.unsubFailures = [];
    state.cancelRequested = false;
    touch();
  }

  window.__ytu = { fetchAll, unsubscribeAll, getState, cancel, reset };
})();
