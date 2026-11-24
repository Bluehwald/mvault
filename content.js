/*
 * Miro Vault – Content-Script für https://miro.com/app/board/*
 *
 *  1. Meldet besuchte Boards (ID aus der URL, Titel aus document.title).
 *  2. Erkennt die Passwortabfrage geschützter Boards (beliebiges sichtbares
 *     <input type="password">), merkt sich das eingegebene Passwort und
 *     speichert es erst, wenn die Abfrage verschwunden ist (= Passwort war richtig).
 *  3. Füllt ein gespeichertes Passwort automatisch ein (falls entsperrt).
 *
 * Das Skript liest nie den Tresor selbst; es fragt nur das Hintergrund-Skript
 * nach dem Passwort für genau das Board, auf dem es läuft.
 */
(() => {
  'use strict';
  if (window.top !== window) return;

  const api = globalThis.browser ?? globalThis.chrome;
  const BOARD_PATH = /^\/app\/board\/([^/?#]+)/;
  const CANDIDATE_MAX_AGE = 60_000;
  const ABSENT_CONFIRM_MS = 1500;

  async function send(type, payload = {}) {
    try {
      const r = await api.runtime.sendMessage({ type, ...payload });
      if (!r?.ok) throw new Error(r?.error || 'Unbekannter Fehler');
      return r.result;
    } catch (e) {
      console.debug('[Miro Vault]', e);
      return null;
    }
  }

  // ---------- Toast ----------

  let toastHost = null;
  function toast(text) {
    if (!toastHost) {
      toastHost = document.createElement('div');
      toastHost.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
      const root = toastHost.attachShadow({ mode: 'closed' });
      root.innerHTML =
        '<style>div{font:13px/1.4 system-ui,sans-serif;background:#050038;color:#fff;padding:10px 14px;' +
        'border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.25);max-width:320px;margin-top:8px;' +
        'border-left:4px solid #ffd02f}</style>';
      toastHost._root = root;
      document.documentElement.appendChild(toastHost);
    }
    const el = document.createElement('div');
    el.textContent = text;
    toastHost._root.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }

  // ---------- Board-Erkennung ----------

  function currentBoardKey() {
    return location.pathname.match(BOARD_PATH)?.[1] ?? null;
  }

  function boardTitle() {
    const t = document.title
      .trim()
      .replace(/\s*[,|–—-]\s*(online whiteboard\b.*|miro)\s*$/i, '')
      .trim();
    return /^(miro|online whiteboard.*)?$/i.test(t) ? '' : t;
  }

  let lastBoardKey = null;
  let lastTitle = '';

  function trackVisit() {
    const key = currentBoardKey();
    const title = boardTitle();
    if (key !== lastBoardKey) {
      lastBoardKey = key;
      lastTitle = title;
      resetPromptState();
      if (key) send('visit', { title, count: true });
    } else if (key && title && title !== lastTitle) {
      lastTitle = title;
      send('visit', { title, count: false });
    }
  }

  // ---------- Passwortabfrage ----------

  const isPasswordInput = (el) => el?.tagName === 'INPUT' && el.type === 'password';
  const isVisible = (el) =>
    el.isConnected && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const passwordInputs = () => [...document.querySelectorAll('input[type="password"]')].filter(isVisible);
  const eventTarget = (e) => (e.composedPath ? e.composedPath()[0] : e.target);

  let typed = '';
  let candidate = null;
  let promptSeen = false;
  let absentSince = 0;
  let autofilled = null;
  let lockedHintShown = false;
  const handledInputs = new WeakSet();

  function resetPromptState() {
    typed = '';
    candidate = null;
    promptSeen = false;
    absentSince = 0;
    autofilled = null;
    lockedHintShown = false;
  }

  function markSubmit() {
    if (typed && lastBoardKey && passwordInputs().length) {
      candidate = { password: typed, boardKey: lastBoardKey, at: Date.now() };
    }
  }

  document.addEventListener('input', (e) => {
    const el = eventTarget(e);
    if (isPasswordInput(el)) typed = el.value;
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && isPasswordInput(eventTarget(e))) markSubmit();
  }, true);

  document.addEventListener('submit', markSubmit, true);

  document.addEventListener('click', (e) => {
    const el = eventTarget(e);
    if (el?.closest?.('button,[role="button"],input[type="submit"]')) markSubmit();
  }, true);

  document.addEventListener('focusin', (e) => {
    const el = eventTarget(e);
    if (isPasswordInput(el) && !el.value) tryAutofill(el);
  }, true);

  function setNativeValue(input, value) {
    // Prototyp-Setter umgeht den Value-Tracker von React & Co.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const SUBMIT_LABEL = /(continue|weiter|submit|senden|open|öffnen|enter|ok|log ?in|anmelden|access|zugreifen)/i;

  function submitNear(input) {
    if (input.form) {
      input.form.requestSubmit();
      return;
    }
    let node = input.parentElement;
    for (let i = 0; i < 6 && node; i++, node = node.parentElement) {
      const btn = [...node.querySelectorAll('button,[role="button"],input[type="submit"]')].find(
        (b) => isVisible(b) && !b.disabled && (b.type === 'submit' || SUBMIT_LABEL.test(b.textContent || b.value || ''))
      );
      if (btn) {
        btn.click();
        return;
      }
    }
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
  }

  async function tryAutofill(input) {
    const r = await send('autofill');
    if (!r?.enabled || !r.hasPassword) return;
    if (r.locked) {
      if (!lockedHintShown) {
        lockedHintShown = true;
        toast('Miro Vault ist gesperrt. Entsperre es im Dashboard und klicke dann ins Passwortfeld.');
      }
      return;
    }
    if (!input.isConnected || input.value) return;
    setNativeValue(input, r.password);
    autofilled = r.password;
    typed = r.password;
    toast('Gespeichertes Passwort eingefügt.');
    if (r.autoSubmit) setTimeout(() => input.isConnected && submitNear(input), 150);
  }

  async function check() {
    const inputs = passwordInputs();
    if (inputs.length) {
      promptSeen = true;
      absentSince = 0;
      for (const input of inputs) {
        if (!handledInputs.has(input)) {
          handledInputs.add(input);
          if (!input.value) tryAutofill(input);
        }
      }
      return;
    }
    if (!promptSeen) return;
    if (!absentSince) {
      absentSince = Date.now();
      return;
    }
    // Abfrage muss eine Weile weg sein, damit ein kurzes Neu-Rendern
    // (z. B. bei falschem Passwort) nicht als Erfolg gewertet wird.
    if (Date.now() - absentSince < ABSENT_CONFIRM_MS) return;

    const c = candidate;
    const wasAutofilled = autofilled;
    resetPromptState();
    if (!c || Date.now() - c.at > CANDIDATE_MAX_AGE || c.boardKey !== currentBoardKey()) return;
    if (c.password === wasAutofilled) return;
    const r = await send('capture', { password: c.password, boardKey: c.boardKey });
    if (r?.saved) toast('Passwort für dieses Board lokal gespeichert.');
    else if (r?.reason === 'no-vault') {
      toast('Miro Vault: Lege im Dashboard ein Master-Passwort an, damit Board-Passwörter gespeichert werden.');
    }
  }

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      check();
    }, 300);
  }

  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(() => {
    trackVisit();
    check();
  }, 1000);
  trackVisit();
  check();
})();
