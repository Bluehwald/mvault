'use strict';

const api = globalThis.browser ?? globalThis.chrome;
const HOST_PERMISSION = { origins: ['https://miro.com/*'] };
const REVEAL_MS = 30_000;

const $ = (sel) => document.querySelector(sel);

const state = {
  status: { hasVault: false, unlocked: false },
  boards: {},
  secrets: {},
  settings: { autofill: true, autoSubmit: false, autoLockMinutes: 30 },
  revealed: new Map(), // id -> Klartext (nur kurz, nur im Speicher dieser Seite)
  editor: null, // { id, kind: 'password' | 'notes' }
  dirty: false,
};

async function send(type, payload = {}) {
  const r = await api.runtime.sendMessage({ type, ...payload });
  if (!r?.ok) throw new Error(r?.error || 'Unbekannter Fehler');
  return r.result;
}

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

const rtf = new Intl.RelativeTimeFormat('de', { numeric: 'auto' });
function relTime(ts) {
  if (!ts) return '–';
  const diff = (ts - Date.now()) / 1000;
  const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [unit, sec] of units) if (Math.abs(diff) >= sec) return rtf.format(Math.round(diff / sec), unit);
  return 'gerade eben';
}
const dateFmt = new Intl.DateTimeFormat('de', { dateStyle: 'medium' });

// ---------- Laden ----------

async function loadData() {
  const data = await api.storage.local.get(['boards', 'secrets', 'settings']);
  state.boards = data.boards ?? {};
  state.secrets = data.secrets ?? {};
  state.settings = { ...state.settings, ...(data.settings ?? {}) };
}

async function loadStatus() {
  const prev = state.status.unlocked;
  state.status = await send('status');
  if (prev && !state.status.unlocked) state.revealed.clear();
}

async function refresh() {
  await Promise.all([loadData(), loadStatus()]);
  renderAll();
}

// ---------- Rendering ----------

function renderAll() {
  renderHeader();
  renderSettings();
  renderBoards();
}

function renderHeader() {
  const { hasVault, unlocked } = state.status;
  const badge = $('#lock-state');
  badge.textContent = !hasVault ? 'Kein Tresor' : unlocked ? 'Entsperrt' : 'Gesperrt';
  badge.className = `badge ${unlocked ? 'unlocked' : 'locked'}`;

  const lockBtn = $('#lock-btn');
  lockBtn.hidden = !hasVault || !unlocked;
  lockBtn.textContent = 'Sperren';

  $('#setup-card').hidden = hasVault;
  $('#unlock-card').hidden = !hasVault || unlocked;
  $('#master-form').hidden = !hasVault;
  $('#master-form').previousElementSibling.hidden = !hasVault;
}

function renderSettings() {
  const f = $('#settings-form');
  if (f.contains(document.activeElement)) return;
  f.autofill.checked = state.settings.autofill;
  f.autoSubmit.checked = state.settings.autoSubmit;
  f.autoLockMinutes.value = state.settings.autoLockMinutes;
}

function filteredBoards() {
  const q = $('#search').value.trim().toLowerCase();
  const onlyPw = $('#only-pw').checked;
  const sort = $('#sort').value;
  let list = Object.values(state.boards);
  if (onlyPw) list = list.filter((b) => state.secrets[b.id]);
  if (q) {
    list = list.filter((b) =>
      [b.title, b.id, b.notes].some((s) => (s ?? '').toLowerCase().includes(q))
    );
  }
  const cmp = {
    lastVisited: (a, b) => (b.lastVisited ?? 0) - (a.lastVisited ?? 0),
    firstVisited: (a, b) => (a.firstVisited ?? 0) - (b.firstVisited ?? 0),
    visits: (a, b) => (b.visits ?? 0) - (a.visits ?? 0),
    title: (a, b) => (a.title || a.id).localeCompare(b.title || b.id, 'de', { sensitivity: 'base' }),
  }[sort];
  return list.sort(cmp);
}

function renderBoards({ force = false } = {}) {
  if (state.editor && !force) {
    state.dirty = true; // Nicht neu zeichnen, solange ein Editor offen ist.
    return;
  }
  state.dirty = false;

  const all = Object.values(state.boards);
  const list = filteredBoards();
  const withPw = all.filter((b) => state.secrets[b.id]).length;
  $('#stats').textContent = all.length
    ? `${all.length} Board${all.length === 1 ? '' : 's'}, davon ${withPw} mit gespeichertem Passwort` +
      (list.length !== all.length ? ` · ${list.length} angezeigt` : '')
    : '';
  $('#empty').hidden = all.length > 0;
  $('#board-list').replaceChildren(...list.map(renderBoard));
}

function renderBoard(b) {
  const hasPw = Boolean(state.secrets[b.id]);
  const unlocked = state.status.unlocked;
  const revealed = state.revealed.get(b.id);
  const lockedTitle = unlocked ? null : 'Zuerst den Tresor entsperren';

  const pwRow = hasPw
    ? h('div', { class: 'pw-row' },
        h('span', { class: 'pw-value' }, revealed ?? '••••••••'),
        h('button', {
          class: 'btn small', type: 'button', disabled: !unlocked, title: lockedTitle,
          onclick: () => toggleReveal(b.id),
        }, revealed ? 'Verbergen' : 'Anzeigen'),
        h('button', {
          class: 'btn small', type: 'button', disabled: !unlocked, title: lockedTitle,
          onclick: (e) => copyPassword(b.id, e.currentTarget),
        }, 'Kopieren'))
    : h('div', { class: 'pw-row' }, h('span', { class: 'pw-none' }, 'Kein Passwort gespeichert'));

  const editor = state.editor?.id === b.id ? renderEditor(b) : null;

  return h('li', { class: 'board' },
    h('div', { class: 'board-head' },
      h('a', { class: 'board-title', href: b.url, target: '_blank', rel: 'noopener noreferrer' }, b.title || 'Unbenanntes Board'),
      h('span', { class: 'board-id' }, b.id)),
    h('div', { class: 'meta' },
      `Zuletzt ${relTime(b.lastVisited)} · ${b.visits ?? 0} Besuch${b.visits === 1 ? '' : 'e'}` +
      (b.firstVisited ? ` · seit ${dateFmt.format(b.firstVisited)}` : '')),
    pwRow,
    b.notes ? h('div', { class: 'notes' }, b.notes) : null,
    editor ?? h('div', { class: 'actions' },
      h('button', {
        class: 'btn small', type: 'button', disabled: !state.status.hasVault,
        title: state.status.hasVault ? null : 'Zuerst ein Master-Passwort anlegen',
        onclick: () => openEditor(b.id, 'password'),
      }, hasPw ? 'Passwort ändern' : 'Passwort setzen'),
      hasPw ? h('button', { class: 'btn small', type: 'button', onclick: () => clearPassword(b) }, 'Passwort entfernen') : null,
      h('button', { class: 'btn small', type: 'button', onclick: () => openEditor(b.id, 'notes') }, b.notes ? 'Notiz bearbeiten' : 'Notiz / Name'),
      h('button', { class: 'btn small danger', type: 'button', onclick: () => deleteBoard(b) }, 'Entfernen')));
}

function renderEditor(b) {
  const err = h('p', { class: 'error', role: 'alert' });
  const close = () => { state.editor = null; renderBoards(); };

  if (state.editor.kind === 'password') {
    const input = h('input', { type: 'password', autocomplete: 'off', placeholder: 'Board-Passwort', 'aria-label': 'Board-Passwort' });
    const form = h('form', {
      class: 'editor',
      onsubmit: async (e) => {
        e.preventDefault();
        if (!input.value) return;
        try {
          await send('setPassword', { id: b.id, password: input.value });
          state.revealed.delete(b.id);
          state.editor = null;
          await refresh();
        } catch (ex) { err.textContent = ex.message; }
      },
    },
      h('div', { class: 'row' }, input,
        h('button', { class: 'btn small primary', type: 'submit' }, 'Speichern'),
        h('button', { class: 'btn small ghost', type: 'button', onclick: close }, 'Abbrechen')),
      err);
    queueMicrotask(() => input.focus());
    return form;
  }

  const title = h('input', { type: 'text', value: b.title ?? '', placeholder: 'Name', 'aria-label': 'Name' });
  const notes = h('textarea', { placeholder: 'Notiz', 'aria-label': 'Notiz' });
  notes.value = b.notes ?? '';
  const form = h('form', {
    class: 'editor',
    onsubmit: async (e) => {
      e.preventDefault();
      try {
        await send('updateBoard', { id: b.id, title: title.value, notes: notes.value });
        state.editor = null;
        await refresh();
      } catch (ex) { err.textContent = ex.message; }
    },
  },
    title, notes,
    h('div', { class: 'row' },
      h('button', { class: 'btn small primary', type: 'submit' }, 'Speichern'),
      h('button', { class: 'btn small ghost', type: 'button', onclick: close }, 'Abbrechen')),
    err);
  queueMicrotask(() => notes.focus());
  return form;
}

// ---------- Aktionen ----------

function openEditor(id, kind) {
  state.editor = { id, kind };
  renderBoards({ force: true });
}

const revealTimers = new Map();
async function toggleReveal(id) {
  if (state.revealed.has(id)) {
    state.revealed.delete(id);
  } else {
    try {
      state.revealed.set(id, await send('getPassword', { id }));
      clearTimeout(revealTimers.get(id));
      revealTimers.set(id, setTimeout(() => { state.revealed.delete(id); renderBoards(); }, REVEAL_MS));
    } catch (e) {
      alert(e.message);
      await refresh();
      return;
    }
  }
  renderBoards();
}

async function copyPassword(id, btn) {
  try {
    const pw = state.revealed.get(id) ?? (await send('getPassword', { id }));
    await navigator.clipboard.writeText(pw);
    btn.textContent = 'Kopiert ✓';
    setTimeout(() => { btn.textContent = 'Kopieren'; }, 1500);
  } catch (e) {
    alert(e.message);
    await refresh();
  }
}

async function clearPassword(b) {
  if (!confirm(`Gespeichertes Passwort für „${b.title || b.id}“ entfernen?`)) return;
  await send('clearPassword', { id: b.id });
  state.revealed.delete(b.id);
  await refresh();
}

async function deleteBoard(b) {
  if (!confirm(`„${b.title || b.id}“ samt gespeichertem Passwort aus der Liste entfernen?`)) return;
  await send('deleteBoard', { id: b.id });
  state.revealed.delete(b.id);
  await refresh();
}

function formError(form, message) {
  form.querySelector('.error').textContent = message ?? '';
}

function bindForms() {
  $('#setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    if (f.pw.value !== f.pw2.value) return formError(f, 'Die Passwörter stimmen nicht überein.');
    formError(f, '');
    const btn = f.querySelector('button');
    btn.disabled = true;
    btn.textContent = 'Wird angelegt…';
    try {
      await send('setup', { password: f.pw.value });
      f.reset();
      await refresh();
    } catch (ex) {
      formError(f, ex.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Tresor anlegen';
    }
  });

  $('#unlock-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const errEl = $('#unlock-card .error');
    errEl.textContent = '';
    const btn = f.querySelector('button');
    btn.disabled = true;
    try {
      await send('unlock', { password: f.pw.value });
      f.reset();
      await refresh();
    } catch (ex) {
      errEl.textContent = ex.message;
      f.pw.select();
    } finally {
      btn.disabled = false;
    }
  });

  $('#lock-btn').addEventListener('click', async () => {
    await send('lock');
    state.revealed.clear();
    await refresh();
  });

  $('#settings-btn').addEventListener('click', (e) => {
    const card = $('#settings');
    card.hidden = !card.hidden;
    e.currentTarget.setAttribute('aria-expanded', String(!card.hidden));
  });

  $('#settings-form').addEventListener('change', async (e) => {
    const f = e.currentTarget;
    state.settings = await send('saveSettings', {
      settings: { autofill: f.autofill.checked, autoSubmit: f.autoSubmit.checked, autoLockMinutes: f.autoLockMinutes.value },
    });
    f.autoLockMinutes.value = state.settings.autoLockMinutes;
    const hint = f.querySelector('.saved-hint');
    hint.textContent = 'Gespeichert.';
    setTimeout(() => { hint.textContent = ''; }, 1500);
  });
  $('#settings-form').addEventListener('submit', (e) => e.preventDefault());

  $('#master-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    if (f.new.value !== f.new2.value) return formError(f, 'Die neuen Passwörter stimmen nicht überein.');
    formError(f, '');
    try {
      await send('changeMaster', { oldPassword: f.old.value, newPassword: f.new.value });
      f.reset();
      formError(f, '');
      alert('Master-Passwort geändert.');
      await refresh();
    } catch (ex) {
      formError(f, ex.message);
    }
  });

  $('#export-btn').addEventListener('click', async () => {
    const data = await api.storage.local.get(['vault', 'boards', 'secrets', 'settings']);
    const payload = { format: 'miro-vault-export', version: 1, exportedAt: new Date().toISOString(), ...data };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `miro-vault-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  $('#import-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const msg = $('#backup-msg');
    try {
      const data = JSON.parse(await file.text());
      const r = await send('importData', { data });
      msg.textContent =
        `Importiert: ${r.boardsImported} Boards, ${r.secretsImported} Passwörter.` +
        (r.vaultAdopted ? ' Der Tresor aus der Datei wurde übernommen – entsperre ihn mit dem dazugehörigen Master-Passwort.' : '') +
        (r.secretsSkipped ? ` ${r.secretsSkipped} Passwörter übersprungen (die Datei gehört zu einem anderen Tresor).` : '');
      await refresh();
    } catch (ex) {
      msg.textContent = `Import fehlgeschlagen: ${ex.message}`;
    }
  });

  $('#wipe-btn').addEventListener('click', async () => {
    if (!confirm('Wirklich ALLE Boards, Passwörter und den Tresor löschen? Das kann nicht rückgängig gemacht werden.')) return;
    await send('wipe');
    state.revealed.clear();
    await refresh();
  });

  $('#add-btn').addEventListener('click', (e) => {
    const f = $('#add-form');
    f.hidden = !f.hidden;
    e.currentTarget.setAttribute('aria-expanded', String(!f.hidden));
    if (!f.hidden) f.url.focus();
  });
  $('#add-form [data-cancel]').addEventListener('click', () => {
    $('#add-form').reset();
    $('#add-form').hidden = true;
    $('#add-btn').setAttribute('aria-expanded', 'false');
  });
  $('#add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    formError(f, '');
    if (f.password.value && !state.status.hasVault) return formError(f, 'Um ein Passwort zu speichern, lege zuerst ein Master-Passwort an.');
    try {
      await send('addBoard', { url: f.url.value.trim(), title: f.title.value, password: f.password.value });
      f.reset();
      f.hidden = true;
      $('#add-btn').setAttribute('aria-expanded', 'false');
      await refresh();
    } catch (ex) {
      formError(f, ex.message);
    }
  });

  for (const id of ['#search', '#sort', '#only-pw']) $(id).addEventListener('input', () => renderBoards());

  $('#perm-btn').addEventListener('click', async () => {
    try {
      await api.permissions.request(HOST_PERMISSION);
    } finally {
      checkPermission();
    }
  });
}

async function checkPermission() {
  try {
    $('#perm-banner').hidden = await api.permissions.contains(HOST_PERMISSION);
  } catch {
    $('#perm-banner').hidden = true;
  }
}

// ---------- Start ----------

bindForms();
checkPermission();
refresh();

api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') refresh();
});

// Änderungen am Editor-Zustand nachholen, sobald er geschlossen ist.
setInterval(() => {
  if (!state.editor && state.dirty) renderBoards();
}, 500);

// Auto-Sperre im Hintergrund widerspiegeln.
setInterval(async () => {
  const before = state.status.unlocked;
  await loadStatus();
  if (before !== state.status.unlocked) renderAll();
}, 15_000);

// Relative Zeiten aktuell halten.
setInterval(() => renderBoards(), 60_000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { refresh(); checkPermission(); }
});
