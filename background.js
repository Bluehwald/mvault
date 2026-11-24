'use strict';
/*
 * Miro Vault – Hintergrund-Skript (Chrome: Service Worker, Firefox: Event Page).
 *
 * Alle Schreibzugriffe und die gesamte Kryptografie laufen hier.
 *
 * Kryptomodell:
 *  - Beim Einrichten wird ein RSA-OAEP-Schlüsselpaar (3072 Bit) erzeugt.
 *  - Der private Schlüssel wird mit einem aus dem Master-Passwort abgeleiteten
 *    AES-GCM-Schlüssel (PBKDF2-SHA256, 600.000 Iterationen) verschlüsselt.
 *  - Board-Passwörter werden hybrid verschlüsselt (zufälliger AES-GCM-Schlüssel,
 *    der mit dem öffentlichen RSA-Schlüssel verpackt wird). Dadurch können neue
 *    Passwörter auch bei gesperrtem Tresor gespeichert werden; lesen kann man
 *    sie nur nach dem Entsperren.
 *  - Der entsperrte private Schlüssel liegt nur in storage.session (Arbeitsspeicher,
 *    nicht für Content-Scripts lesbar, wird beim Schließen des Browsers verworfen).
 *
 * Es gibt keinerlei Netzwerkzugriffe.
 */

const api = globalThis.browser ?? globalThis.chrome;

const PBKDF2_ITERATIONS = 600_000;
const DEFAULT_SETTINGS = { autofill: true, autoSubmit: false, autoLockMinutes: 30 };
const BOARD_PATH = /^\/app\/board\/([^/?#]+)/;
const EXTENSION_ORIGIN = api.runtime.getURL('');
const DASHBOARD_URL = api.runtime.getURL('dashboard.html');
const MAX_SECRET_LENGTH = 1024;

const te = new TextEncoder();
const td = new TextDecoder();

// ---------- Hilfsfunktionen ----------

function toB64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromB64(s) {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

function boardIdFromUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.hostname !== 'miro.com') return null;
    const m = u.pathname.match(BOARD_PATH);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function boardUrl(id) {
  return `https://miro.com/app/board/${id}/`;
}

function cleanText(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

// Serialisiert alle Schreibzugriffe, damit sich parallele Nachrichten
// (z. B. mehrere Tabs) nicht gegenseitig überschreiben.
let queue = Promise.resolve();
function mutate(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

async function getSettings() {
  const { settings } = await api.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
}

// ---------- Kryptografie ----------

async function deriveKek(password, saltB64, iterations) {
  const base = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(saltB64), iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function wrapPrivateKey(pkcs8, password) {
  const salt = toB64(randomBytes(16));
  const kek = await deriveKek(password, salt, PBKDF2_ITERATIONS);
  const iv = randomBytes(12);
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, pkcs8);
  return {
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: PBKDF2_ITERATIONS, salt },
    privateKey: { iv: toB64(iv), data: toB64(data) },
  };
}

async function unwrapPrivateKey(vault, password) {
  const kek = await deriveKek(password, vault.kdf.salt, vault.kdf.iterations);
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromB64(vault.privateKey.iv) },
        kek,
        fromB64(vault.privateKey.data)
      )
    );
  } catch {
    throw new Error('Falsches Master-Passwort.');
  }
}

async function encryptSecret(vault, plaintext) {
  const pub = await crypto.subtle.importKey(
    'spki', fromB64(vault.publicKey), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']
  );
  const aesKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = randomBytes(12);
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, te.encode(plaintext));
  const raw = await crypto.subtle.exportKey('raw', aesKey);
  const wrappedKey = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pub, raw);
  return { wrappedKey: toB64(wrappedKey), iv: toB64(iv), data: toB64(data) };
}

async function decryptSecret(privateKey, secret) {
  const raw = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, fromB64(secret.wrappedKey));
  const aesKey = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(secret.iv) }, aesKey, fromB64(secret.data));
  return td.decode(plain);
}

// ---------- Sperren / Entsperren ----------

function expiryFrom(settings) {
  const minutes = Number(settings.autoLockMinutes);
  return minutes > 0 ? Date.now() + minutes * 60_000 : Number.MAX_SAFE_INTEGER;
}

async function setUnlocked(pkcs8) {
  const settings = await getSettings();
  await api.storage.session.set({ unlocked: { pkcs8: toB64(pkcs8), expiresAt: expiryFrom(settings) } });
}

async function lock() {
  await api.storage.session.remove('unlocked');
}

/** Liefert den privaten Schlüssel, wenn entsperrt (und verlängert die Auto-Sperre). */
async function getPrivateKey({ touch = true } = {}) {
  const { unlocked } = await api.storage.session.get('unlocked');
  if (!unlocked) return null;
  if (Date.now() > unlocked.expiresAt) {
    await lock();
    return null;
  }
  if (touch) {
    const settings = await getSettings();
    await api.storage.session.set({ unlocked: { ...unlocked, expiresAt: expiryFrom(settings) } });
  }
  return crypto.subtle.importKey(
    'pkcs8', fromB64(unlocked.pkcs8), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']
  );
}

async function requirePrivateKey() {
  const key = await getPrivateKey();
  if (!key) throw new Error('Der Tresor ist gesperrt.');
  return key;
}

function checkMasterPassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('Das Master-Passwort muss mindestens 8 Zeichen lang sein.');
  }
}

async function setupVault(password) {
  checkMasterPassword(password);
  return mutate(async () => {
    const { vault: existing } = await api.storage.local.get('vault');
    if (existing) throw new Error('Es gibt bereits einen Tresor.');
    const pair = await crypto.subtle.generateKey(
      { name: 'RSA-OAEP', modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['encrypt', 'decrypt']
    );
    const spki = await crypto.subtle.exportKey('spki', pair.publicKey);
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
    const vault = { version: 1, createdAt: Date.now(), publicKey: toB64(spki), ...(await wrapPrivateKey(pkcs8, password)) };
    await api.storage.local.set({ vault });
    await setUnlocked(pkcs8);
    return true;
  });
}

async function unlock(password) {
  const { vault } = await api.storage.local.get('vault');
  if (!vault) throw new Error('Es wurde noch kein Tresor eingerichtet.');
  const pkcs8 = await unwrapPrivateKey(vault, String(password ?? ''));
  await setUnlocked(pkcs8);
  return true;
}

async function changeMasterPassword(oldPassword, newPassword) {
  checkMasterPassword(newPassword);
  return mutate(async () => {
    const { vault } = await api.storage.local.get('vault');
    if (!vault) throw new Error('Es wurde noch kein Tresor eingerichtet.');
    const pkcs8 = await unwrapPrivateKey(vault, String(oldPassword ?? ''));
    await api.storage.local.set({ vault: { ...vault, ...(await wrapPrivateKey(pkcs8, newPassword)) } });
    await setUnlocked(pkcs8);
    return true;
  });
}

// ---------- Boards & Passwörter ----------

function newBoard(id, now) {
  return { id, url: boardUrl(id), title: '', notes: '', firstVisited: now, lastVisited: now, visits: 0 };
}

function recordVisit(id, title, count) {
  return mutate(async () => {
    const { boards = {} } = await api.storage.local.get('boards');
    const now = Date.now();
    const board = boards[id] ?? newBoard(id, now);
    const cleanTitle = cleanText(title, 300);
    if (cleanTitle) board.title = cleanTitle;
    if (count) {
      board.visits = (board.visits ?? 0) + 1;
      board.lastVisited = now;
    }
    boards[id] = board;
    await api.storage.local.set({ boards });
    return true;
  });
}

function storePassword(id, password) {
  if (typeof password !== 'string' || !password || password.length > MAX_SECRET_LENGTH) {
    throw new Error('Ungültiges Passwort.');
  }
  return mutate(async () => {
    const { vault, boards = {}, secrets = {} } = await api.storage.local.get(['vault', 'boards', 'secrets']);
    if (!vault) return { saved: false, reason: 'no-vault' };
    secrets[id] = { ...(await encryptSecret(vault, password)), savedAt: Date.now() };
    boards[id] ??= newBoard(id, Date.now());
    await api.storage.local.set({ boards, secrets });
    return { saved: true };
  });
}

async function readPassword(id) {
  const { secrets = {} } = await api.storage.local.get('secrets');
  const secret = secrets[id];
  if (!secret) return null;
  return decryptSecret(await requirePrivateKey(), secret);
}

function sanitizeBoard(id, b) {
  const num = (v) => (Number.isFinite(v) ? v : undefined);
  return Object.fromEntries(
    Object.entries({
      id,
      url: boardUrl(id),
      title: cleanText(b.title, 300),
      notes: cleanText(b.notes, 5000),
      firstVisited: num(b.firstVisited),
      lastVisited: num(b.lastVisited),
      visits: num(b.visits),
    }).filter(([, v]) => v !== undefined)
  );
}

const VALID_ID = /^[^/?#\s]{1,200}$/;

function importData(data) {
  if (!data || data.format !== 'miro-vault-export') throw new Error('Das ist keine Miro-Vault-Exportdatei.');
  return mutate(async () => {
    const cur = await api.storage.local.get(['vault', 'boards', 'secrets']);
    const boards = { ...(cur.boards ?? {}) };
    let boardsImported = 0;
    for (const [id, b] of Object.entries(data.boards ?? {})) {
      if (!VALID_ID.test(id) || typeof b !== 'object' || !b) continue;
      const existing = boards[id];
      const incoming = sanitizeBoard(id, b);
      if (!existing) {
        boards[id] = incoming;
      } else {
        boards[id] = {
          ...existing,
          title: existing.title || incoming.title || '',
          notes: existing.notes || incoming.notes || '',
          firstVisited: Math.min(existing.firstVisited ?? Infinity, incoming.firstVisited ?? Infinity),
          lastVisited: Math.max(existing.lastVisited ?? 0, incoming.lastVisited ?? 0),
          visits: Math.max(existing.visits ?? 0, incoming.visits ?? 0),
        };
      }
      boardsImported++;
    }

    let vault = cur.vault;
    let vaultAdopted = false;
    if (!vault && data.vault?.publicKey && data.vault?.privateKey && data.vault?.kdf) {
      vault = data.vault;
      vaultAdopted = true;
    }

    const secrets = { ...(cur.secrets ?? {}) };
    const incomingSecrets = Object.entries(data.secrets ?? {});
    let secretsImported = 0;
    let secretsSkipped = 0;
    const sameVault = vault && data.vault && vault.publicKey === data.vault.publicKey;
    for (const [id, s] of incomingSecrets) {
      if (!sameVault || !VALID_ID.test(id) || !s?.wrappedKey || !s?.iv || !s?.data) {
        secretsSkipped++;
        continue;
      }
      if (!secrets[id] || (s.savedAt ?? 0) > (secrets[id].savedAt ?? 0)) {
        secrets[id] = { wrappedKey: s.wrappedKey, iv: s.iv, data: s.data, savedAt: s.savedAt ?? Date.now() };
        boards[id] ??= newBoard(id, Date.now());
        secretsImported++;
      }
    }

    await api.storage.local.set({ vault, boards, secrets });
    return { boardsImported, secretsImported, secretsSkipped, vaultAdopted };
  });
}

// ---------- Nachrichten ----------

async function handleContentMessage(msg, sender) {
  const id = boardIdFromUrl(sender.url);
  if (!id) throw new Error('Keine Board-Seite.');

  switch (msg.type) {
    case 'visit':
      return recordVisit(id, msg.title, Boolean(msg.count));

    case 'capture':
      // Schutz davor, ein Passwort dem falschen Board zuzuordnen (SPA-Navigation).
      if (msg.boardKey !== id) return { saved: false, reason: 'board-changed' };
      return storePassword(id, msg.password);

    case 'autofill': {
      const settings = await getSettings();
      if (!settings.autofill) return { enabled: false };
      const { secrets = {} } = await api.storage.local.get('secrets');
      if (!secrets[id]) return { enabled: true, hasPassword: false };
      const key = await getPrivateKey();
      if (!key) return { enabled: true, hasPassword: true, locked: true };
      return {
        enabled: true,
        hasPassword: true,
        locked: false,
        password: await decryptSecret(key, secrets[id]),
        autoSubmit: Boolean(settings.autoSubmit),
      };
    }

    default:
      throw new Error('Unbekannte Aktion.');
  }
}

async function handleDashboardMessage(msg) {
  switch (msg.type) {
    case 'status': {
      const { vault } = await api.storage.local.get('vault');
      const key = await getPrivateKey({ touch: false });
      return { hasVault: Boolean(vault), unlocked: Boolean(key) };
    }
    case 'setup':
      return setupVault(msg.password);
    case 'unlock':
      return unlock(msg.password);
    case 'lock':
      return lock();
    case 'changeMaster':
      return changeMasterPassword(msg.oldPassword, msg.newPassword);

    case 'getPassword':
      return readPassword(msg.id);

    case 'setPassword': {
      const r = await storePassword(msg.id, msg.password);
      if (!r.saved) throw new Error('Bitte zuerst ein Master-Passwort anlegen.');
      return r;
    }

    case 'clearPassword':
      return mutate(async () => {
        const { secrets = {} } = await api.storage.local.get('secrets');
        delete secrets[msg.id];
        await api.storage.local.set({ secrets });
        return true;
      });

    case 'addBoard': {
      const id = boardIdFromUrl(msg.url);
      if (!id) throw new Error('Das ist keine gültige Miro-Board-URL (https://miro.com/app/board/…).');
      await mutate(async () => {
        const { boards = {} } = await api.storage.local.get('boards');
        const board = boards[id] ?? newBoard(id, Date.now());
        const title = cleanText(msg.title, 300);
        if (title) board.title = title;
        boards[id] = board;
        await api.storage.local.set({ boards });
      });
      if (msg.password) await storePassword(id, msg.password);
      return id;
    }

    case 'updateBoard':
      return mutate(async () => {
        const { boards = {} } = await api.storage.local.get('boards');
        const board = boards[msg.id];
        if (!board) throw new Error('Board nicht gefunden.');
        if ('title' in msg) board.title = cleanText(msg.title, 300);
        if ('notes' in msg) board.notes = cleanText(msg.notes, 5000);
        await api.storage.local.set({ boards });
        return true;
      });

    case 'deleteBoard':
      return mutate(async () => {
        const { boards = {}, secrets = {} } = await api.storage.local.get(['boards', 'secrets']);
        delete boards[msg.id];
        delete secrets[msg.id];
        await api.storage.local.set({ boards, secrets });
        return true;
      });

    case 'saveSettings':
      return mutate(async () => {
        const s = msg.settings ?? {};
        const settings = {
          autofill: Boolean(s.autofill),
          autoSubmit: Boolean(s.autoSubmit),
          autoLockMinutes: Math.max(0, Math.min(24 * 60, Math.round(Number(s.autoLockMinutes) || 0))),
        };
        await api.storage.local.set({ settings });
        // Neue Auto-Sperrzeit sofort anwenden.
        const { unlocked } = await api.storage.session.get('unlocked');
        if (unlocked) await api.storage.session.set({ unlocked: { ...unlocked, expiresAt: expiryFrom(settings) } });
        return settings;
      });

    case 'importData':
      return importData(msg.data);

    case 'wipe':
      return mutate(async () => {
        await api.storage.local.clear();
        await lock();
        return true;
      });

    default:
      throw new Error('Unbekannte Aktion.');
  }
}

function isExtensionPage(sender) {
  return sender.id === api.runtime.id && typeof sender.url === 'string' && sender.url.startsWith(EXTENSION_ORIGIN);
}

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== api.runtime.id || !msg || typeof msg.type !== 'string') return false;
  const work = isExtensionPage(sender) ? handleDashboardMessage(msg) : handleContentMessage(msg, sender);
  work.then(
    (result) => sendResponse({ ok: true, result }),
    (error) => sendResponse({ ok: false, error: error?.message ?? String(error) })
  );
  return true; // Antwort kommt asynchron
});

api.action.onClicked.addListener(() => {
  api.tabs.create({ url: DASHBOARD_URL });
});

api.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') api.tabs.create({ url: DASHBOARD_URL });
});
