// Header search-as-you-type for the static sites (help, docs). Vanilla ARIA combobox over the
// build-time MiniSearch index of the page's locale. Results show from the 1st character (one Arabic
// letter is a word), the index loads on first focus, and matched text is marked with <mark> text nodes
// (textContent only, never innerHTML). The search page (#search-root) has its own live results, so the
// header box stays a plain form there.
import MiniSearch from 'minisearch';
import { searchOptions, querySettings, normalizeTerm } from '../search-core.mjs';

const MSG = {
  ar: {
    loading: 'بندوّر…',
    none: 'مفيش نتايج لـ «{q}»',
    error: 'البحث مش شغال دلوقتي. جرّب تاني.',
    count: '{n} نتيجة',
    one: 'نتيجة واحدة',
    all: 'كل النتايج لـ «{q}»',
    label: 'نتايج البحث',
  },
  en: {
    loading: 'Searching…',
    none: 'No results for “{q}”',
    error: 'Search is unavailable right now. Try again.',
    count: '{n} results',
    one: '1 result',
    all: 'See all results for “{q}”',
    label: 'Search results',
  },
};
const MAX = 6;

const form = document.querySelector('form.search');
const input = form && form.querySelector('input[type="search"]');
if (form && input && !document.getElementById('search-root')) {
  const lang = document.documentElement.lang === 'ar' ? 'ar' : 'en';
  const m = MSG[lang];
  const id = 'ta-' + Math.random().toString(36).slice(2, 8);
  const list = document.createElement('ul');
  list.id = id + '-list';
  list.className = 'ta-list';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', m.label);
  list.hidden = true;
  const note = document.createElement('p');
  note.className = 'ta-note';
  note.hidden = true;
  const live = document.createElement('p');
  live.className = 'sr-only';
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  form.append(list, note, live);

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-haspopup', 'listbox');
  input.setAttribute('aria-controls', list.id);
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('autocomplete', 'off');

  let mini = null;
  let loadState = 'idle'; // idle | loading | ready | error
  let hits = [];
  let active = -1;
  let timer = 0;
  let token = 0;

  const load = () => {
    if (loadState !== 'idle') return;
    loadState = 'loading';
    fetch(form.dataset.index)
      .then(r => {
        if (!r.ok) throw new Error(String(r.status));
        return r.text();
      })
      .then(json => {
        mini = MiniSearch.loadJSON(json, searchOptions);
        loadState = 'ready';
        run();
      })
      .catch(() => {
        loadState = 'error';
        run();
      });
  };

  // The <a> itself is the option (a focusable link nested in an option fails axe nested-interactive).
  const opts = () => [...list.querySelectorAll('[role=option]')];
  const setActive = i => {
    active = i;
    opts().forEach((o, k) => {
      const on = k === i;
      o.setAttribute('aria-selected', String(on));
      if (on) o.scrollIntoView({ block: 'nearest' });
    });
    if (i >= 0) input.setAttribute('aria-activedescendant', opts()[i].id);
    else input.removeAttribute('aria-activedescendant');
  };

  const close = () => {
    list.hidden = true;
    note.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  };

  // Mark the words of `q` inside `text`, folding like the index does but cutting the original text.
  const marks = (text, q) => {
    const tokens = q.split(/\s+/).map(normalizeTerm).filter(Boolean);
    let folded = '';
    const origin = [];
    for (let i = 0; i < text.length; i++) {
      const f = normalizeTerm(text[i]);
      for (let k = 0; k < f.length; k++) origin.push(i);
      folded += f;
    }
    const hit = new Array(text.length).fill(false);
    for (const t of tokens) {
      for (let at = folded.indexOf(t); at !== -1; at = folded.indexOf(t, at + t.length)) {
        for (let p = origin[at]; p <= origin[at + t.length - 1]; p++) hit[p] = true;
      }
    }
    const frag = document.createDocumentFragment();
    for (let i = 0; i < text.length; ) {
      let j = i + 1;
      while (j < text.length && hit[j] === hit[i]) j++;
      const piece = text.slice(i, j);
      if (hit[i]) {
        const mk = document.createElement('mark');
        mk.textContent = piece;
        frag.append(mk);
      } else frag.append(piece);
      i = j;
    }
    return frag;
  };

  const show = (q, status) => {
    list.textContent = '';
    note.hidden = true;
    if (status === 'results') {
      hits.forEach((h, i) => {
        const li = document.createElement('li');
        li.setAttribute('role', 'presentation');
        const a = document.createElement('a');
        a.id = `${id}-opt-${i}`;
        a.setAttribute('role', 'option');
        a.setAttribute('aria-selected', 'false');
        a.href = h.id;
        a.tabIndex = -1;
        const t = document.createElement('span');
        t.className = 'ta-title';
        t.append(marks(h.title, q));
        const s = document.createElement('span');
        s.className = 'ta-sec muted small';
        s.textContent = h.section;
        a.append(t, s);
        li.append(a);
        list.append(li);
      });
      const all = document.createElement('li');
      all.setAttribute('role', 'presentation');
      const link = document.createElement('a');
      link.id = `${id}-opt-${hits.length}`;
      link.setAttribute('role', 'option');
      link.setAttribute('aria-selected', 'false');
      link.tabIndex = -1;
      link.href = form.getAttribute('action') + '?q=' + encodeURIComponent(q);
      link.className = 'ta-all';
      link.textContent = m.all.replace('{q}', q);
      all.append(link);
      list.append(all);
      list.hidden = false;
      live.textContent = hits.length === 1 ? m.one : m.count.replace('{n}', String(hits.length));
    } else {
      list.hidden = true;
      note.textContent =
        status === 'loading' ? m.loading : status === 'error' ? m.error : m.none.replace('{q}', q);
      note.hidden = false;
      live.textContent = note.textContent;
    }
    input.setAttribute('aria-expanded', 'true');
    active = -1;
    input.removeAttribute('aria-activedescendant');
  };

  const run = () => {
    const q = input.value.trim().slice(0, 100);
    if (!q) return close();
    if (loadState === 'idle') return load();
    if (loadState === 'loading') return show(q, 'loading');
    if (loadState === 'error') return show(q, 'error');
    // The index is per locale already (docs' Arabic pages point at the English one), so no lang filter.
    hits = mini.search(q, querySettings).slice(0, MAX);
    show(q, hits.length ? 'results' : 'none');
  };

  input.addEventListener('focus', load);
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const mine = ++token;
    timer = setTimeout(() => mine === token && run(), 60);
  });
  input.addEventListener('keydown', e => {
    const n = list.hidden ? 0 : opts().length;
    if (e.key === 'ArrowDown' && n) {
      e.preventDefault();
      setActive((active + 1) % n);
    } else if (e.key === 'ArrowUp' && n) {
      e.preventDefault();
      setActive(active <= 0 ? n - 1 : active - 1);
    } else if (e.key === 'Home' && n) {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End' && n) {
      e.preventDefault();
      setActive(n - 1);
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      opts()[active].click();
    } else if (e.key === 'Escape') {
      if (!list.hidden || !note.hidden) {
        e.preventDefault();
        close();
      }
    } else if (e.key === 'Tab') close();
  });
  document.addEventListener('mousedown', e => {
    if (!form.contains(e.target)) close();
  });
  list.addEventListener('mousedown', e => e.preventDefault()); // keep focus in the input
}
