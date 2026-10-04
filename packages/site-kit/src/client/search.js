// Client-side search page script. Loads the build-time MiniSearch index and renders results
// for ?q= (and live as the user types). DOM is built with textContent only (no innerHTML).
import MiniSearch from 'minisearch';
import { searchOptions, querySettings } from '../search-core.mjs';

const root = document.getElementById('search-root');
if (root) {
  const lang = root.dataset.lang;
  const input = document.getElementById('q');
  const list = document.getElementById('results');
  const status = document.getElementById('results-status');
  const msg = JSON.parse(root.dataset.messages);
  let mini = null;
  const initial = new URLSearchParams(location.search).get('q');
  if (initial && !input.value) input.value = initial;

  const render = query => {
    list.textContent = '';
    const q = query.trim();
    if (!q) {
      status.textContent = '';
      return;
    }
    const hits = mini.search(q, { ...querySettings, filter: r => r.lang === lang }).slice(0, 20);
    status.textContent = hits.length ? msg.count.replace('{n}', String(hits.length)) : msg.none;
    for (const h of hits) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = h.id;
      a.textContent = h.title;
      const sec = document.createElement('span');
      sec.className = 'muted small';
      sec.textContent = ' · ' + h.section;
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = h.snippet;
      li.append(a, sec, p);
      list.append(li);
    }
  };

  status.textContent = msg.loading;
  fetch(root.dataset.index)
    .then(r => r.text())
    .then(json => {
      mini = MiniSearch.loadJSON(json, searchOptions);
      status.textContent = '';
      render(input.value);
      input.addEventListener('input', () => render(input.value));
    })
    .catch(() => {
      status.textContent = msg.error;
    });
}
