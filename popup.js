const YT_TAB_QUERY = 'https://www.youtube.com/*';
const YT_DEFAULT_URL = 'https://www.youtube.com/feed/channels';

const $ = id => document.getElementById(id);
const els = {
  status: $('status'),
  count: $('count'),
  pages: $('pages'),
  done: $('done'),
  failed: $('failed'),
  progress: $('progress'),
  concurrency: $('concurrency'),
  fetch: $('fetch'),
  download: $('download'),
  unsubscribe: $('unsubscribe'),
  cancel: $('cancel'),
  failuresBox: $('failures-box'),
  failures: $('failures'),
};

let tabId = null;
let pollTimer = null;
let lastState = null;
let cachedSubs = []; // subscriptions kept for CSV download

function setStatus(msg) { els.status.textContent = msg; }

async function getOrCreateYTTab() {
  const tabs = await chrome.tabs.query({ url: YT_TAB_QUERY });
  if (tabs.length) {
    const active = tabs.find(t => t.active);
    return active || tabs[0];
  }
  return chrome.tabs.create({ url: YT_DEFAULT_URL, active: false });
}

function waitForComplete(id) {
  return new Promise(resolve => {
    chrome.tabs.get(id, tab => {
      if (chrome.runtime.lastError || !tab) return resolve(false);
      if (tab.status === 'complete') return resolve(true);
      const listener = (updatedId, info) => {
        if (updatedId === id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve(true);
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  });
}

async function injectController() {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    files: ['inject.js'],
  });
}

async function callPage(method, ...args) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (m, a) => {
        if (!window.__ytu) return { __error: 'controller not loaded' };
        try {
          const ret = window.__ytu[m](...a);
          return Promise.resolve(ret).catch(e => ({ __error: e?.message || String(e) }));
        } catch (e) {
          return { __error: e?.message || String(e) };
        }
      },
      args: [method, args],
    });
    return results?.[0]?.result;
  } catch (e) {
    return { __error: e?.message || String(e) };
  }
}

function render(s) {
  if (!s) return;
  lastState = s;
  els.count.textContent = s.subscriptions.length;
  els.pages.textContent = s.fetchPages || 0;
  els.done.textContent = s.unsubDone || 0;
  els.failed.textContent = s.unsubFailureCount || 0;

  if (s.fetching) {
    setStatus(`Fetching… ${s.subscriptions.length} channels found across ${s.fetchPages} pages`);
  } else if (s.fetchError) {
    setStatus(`Fetch error: ${s.fetchError}`);
  } else if (s.unsubscribing) {
    const pct = s.unsubTotal ? (s.unsubDone / s.unsubTotal) * 100 : 0;
    els.progress.style.width = pct + '%';
    setStatus(`Unsubscribing… ${s.unsubDone}/${s.unsubTotal} (${s.unsubFailureCount} failed)`);
  } else if (s.unsubTotal > 0 && !s.unsubscribing) {
    const ok = s.unsubDone - s.unsubFailureCount;
    els.progress.style.width = '100%';
    setStatus(`Done — ${ok} unsubscribed, ${s.unsubFailureCount} failed.`);
  } else if (s.fetchDone) {
    setStatus(`Fetched ${s.subscriptions.length} subscriptions. Review, optionally export, then unsubscribe.`);
  }

  els.fetch.disabled = s.fetching;
  els.download.disabled = s.subscriptions.length === 0;
  els.unsubscribe.disabled = s.subscriptions.length === 0 || s.unsubscribing || s.fetching;
  els.cancel.disabled = !(s.fetching || s.unsubscribing);

  if (s.unsubFailuresSample && s.unsubFailuresSample.length) {
    els.failuresBox.hidden = false;
    els.failures.innerHTML = '';
    for (const f of s.unsubFailuresSample) {
      const li = document.createElement('li');
      li.textContent = `${f.title || f.id}: ${f.error}`;
      els.failures.appendChild(li);
    }
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    const s = await callPage('getState');
    if (s && !s.__error) {
      if (s.subscriptions.length) cachedSubs = s.subscriptions;
      render(s);
      if (!s.fetching && !s.unsubscribing) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }
  }, 400);
}

async function init() {
  setStatus('Locating a youtube.com tab…');
  let tab;
  try {
    tab = await getOrCreateYTTab();
  } catch (e) {
    setStatus(`Could not open YouTube: ${e.message}`);
    return;
  }
  tabId = tab.id;
  setStatus('Waiting for the YouTube tab to finish loading…');
  await waitForComplete(tabId);
  try {
    await injectController();
  } catch (e) {
    setStatus(`Failed to inject controller: ${e.message}. Reload the YouTube tab and try again.`);
    return;
  }
  setStatus('Ready. Click "Fetch subscriptions" to begin.');
  els.fetch.disabled = false;

  // If a prior run already populated state, restore the view immediately.
  const s = await callPage('getState');
  if (s && !s.__error) {
    if (s.subscriptions.length) cachedSubs = s.subscriptions;
    render(s);
    if (s.fetching || s.unsubscribing) startPolling();
  }
}

els.fetch.addEventListener('click', async () => {
  els.fetch.disabled = true;
  setStatus('Starting fetch…');
  callPage('fetchAll'); // fire-and-forget; we poll for progress
  startPolling();
});

els.unsubscribe.addEventListener('click', async () => {
  const total = lastState?.subscriptions.length || 0;
  if (!total) return;
  const concurrency = Number(els.concurrency.value) || 8;
  const confirmed = confirm(
    `Unsubscribe from ${total} channels?\n\nThis cannot be undone from this extension. ` +
    `Consider downloading the CSV backup first.`
  );
  if (!confirmed) return;
  els.unsubscribe.disabled = true;
  setStatus('Starting unsubscribe…');
  callPage('unsubscribeAll', { concurrency });
  startPolling();
});

els.cancel.addEventListener('click', () => {
  callPage('cancel');
  setStatus('Cancellation requested…');
});

els.download.addEventListener('click', () => {
  const subs = cachedSubs.length ? cachedSubs : (lastState?.subscriptions || []);
  if (!subs.length) return;
  const lines = ['channelId,title'];
  for (const s of subs) {
    const t = (s.title || '').replace(/"/g, '""');
    lines.push(`${s.id},"${t}"`);
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `youtube_subscriptions_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

init();
