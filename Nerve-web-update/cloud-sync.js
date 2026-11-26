import { cloudConfig } from './cloud-config.js';

const encoder = new TextEncoder();
const MAX_CHANGES = 100;
const BATCH_BYTES = 4 * 1024 * 1024;

export const cloudSessionKey = 'nerve-cloud-session-v1';

export function isCloudSession(session) {
  return typeof session?.accessToken === 'string'
    && typeof session.refreshToken === 'string'
    && Number.isFinite(session.expiresAt)
    && typeof session.userId === 'string'
    && typeof session.email === 'string';
}

function readSession(result) {
  const session = {
    accessToken: result.access_token,
    refreshToken: result.refresh_token,
    expiresAt: result.expires_at ?? (Date.now() / 1000 + Number(result.expires_in)),
    userId: result.user?.id,
    email: result.user?.email
  };
  if (!isCloudSession(session)) throw new Error('Invalid cloud session');
  return session;
}

async function request(path, body, accessToken) {
  const headers = { apikey: cloudConfig.publishableKey, 'Content-Type': 'application/json' };
  if (accessToken) headers.Authorization = 'Bearer ' + accessToken;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(cloudConfig.url + path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error('Cloud request failed');
      error.status = response.status;
      error.code = result?.error_code ?? result?.code;
      throw error;
    }
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

export const cloudApi = {
  async signIn(email, password) {
    return readSession(await request('/auth/v1/token?grant_type=password', { email, password }));
  },

  async signUp(email, password, redirectTo) {
    const result = await request('/auth/v1/signup?redirect_to=' + encodeURIComponent(redirectTo), { email, password });
    return result?.access_token ? readSession(result) : null;
  },

  async refresh(session) {
    const refreshed = readSession(await request('/auth/v1/token?grant_type=refresh_token', {
      refresh_token: session.refreshToken
    }));
    if (refreshed.userId !== session.userId) throw new Error('Cloud account changed');
    return refreshed;
  },

  signOut(session) {
    return request('/auth/v1/logout?scope=local', {}, session.accessToken);
  },

  deleteAccount(session) {
    return request('/rest/v1/rpc/nerve_delete_account', {}, session.accessToken);
  },

  exchange(session, cursor, changes) {
    return request('/rest/v1/rpc/nerve_sync_exchange', {
      p_cursor: cursor,
      p_changes: changes
    }, session.accessToken);
  }
};

async function fingerprint(serialized) {
  const bytes = encoder.encode(serialized);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return {
    hash: Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join(''),
    size: bytes.byteLength
  };
}

export async function prepareExchange(notes, baseline, isLocalExample = () => false) {
  const local = new Map();
  const dirty = new Set();
  const changes = [];
  const submitted = new Map();
  let bytes = 0;

  function queue(id, note, serialized, size) {
    dirty.add(id);
    if (changes.length >= MAX_CHANGES || (changes.length > 0 && bytes + size > BATCH_BYTES)) return;
    changes.push({ id, note, baseRevision: baseline.notes.get(id)?.revision ?? 0 });
    submitted.set(id, serialized);
    bytes += size;
  }

  for (const note of notes) {
    const serialized = JSON.stringify(note);
    local.set(note.id, serialized);
    if (!baseline.notes.has(note.id) && isLocalExample(note)) continue;
    const { hash, size } = await fingerprint(serialized);
    if (hash !== baseline.notes.get(note.id)?.hash) queue(note.id, note, serialized, size);
  }
  for (const [id, revision] of baseline.notes) {
    if (revision.hash && !local.has(id)) queue(id, null, null, 0);
  }
  return { local, dirty, changes, submitted };
}

export async function readExchange(result, baseline, normalizeNote) {
  if (!Number.isSafeInteger(result?.cursor) || result.cursor < baseline.cursor || !Array.isArray(result.notes)) {
    throw new Error('Invalid cloud cursor');
  }
  const revisions = new Map(baseline.notes);
  const updated = new Set();
  const notes = [];
  for (const row of result.notes) {
    if (typeof row?.id !== 'string' || !row.id || updated.has(row.id)
        || !Number.isSafeInteger(row.revision) || row.revision < 1 || row.revision > result.cursor
        || row.revision < (revisions.get(row.id)?.revision ?? 0)
        || typeof row.conflict !== 'boolean'
        || (row.note !== null && (row.note?.id !== row.id || typeof row.note.title !== 'string'
          || typeof row.note.body !== 'string' || !Array.isArray(row.note.images)))) {
      throw new Error('Invalid cloud revision');
    }
    updated.add(row.id);
    const note = row.note === null ? null : normalizeNote(row.note);
    const serialized = note === null ? null : JSON.stringify(note);
    const hash = serialized === null ? null : (await fingerprint(serialized)).hash;
    revisions.set(row.id, { revision: row.revision, hash });
    notes.push({ ...row, note, serialized });
  }
  return { cursor: result.cursor, revisions, notes };
}

export async function mergeExchange(store, prepared, exchange, normalizeNote, makeConflictCopy) {
  let conflicts = 0;
  for (const remote of exchange.notes) {
    const current = await store.get(remote.id);
    const serialized = current ? JSON.stringify(normalizeNote(current)) : null;
    const beforeRequest = prepared.local.get(remote.id) ?? null;

    if (serialized === remote.serialized) continue;

    const isAcknowledged = !remote.conflict && prepared.submitted.has(remote.id)
      && prepared.submitted.get(remote.id) === remote.serialized;
    if (isAcknowledged && serialized !== beforeRequest) continue;

    if (!isAcknowledged && (serialized !== beforeRequest || prepared.dirty.has(remote.id))) {
      if (current) store.put(makeConflictCopy(current));
      conflicts++;
    }
    if (remote.note) store.put(remote.note);
    else store.remove(remote.id);
  }
  return conflicts;
}
