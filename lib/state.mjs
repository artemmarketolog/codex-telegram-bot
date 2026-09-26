import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

const queueStatuses = new Set(['waiting', 'dispatching', 'sent', 'cancelled', 'uncertain', 'error']);
const queueRow = row => row ? { id: row.id, threadId: row.thread_id, messageId: row.message_id, input: JSON.parse(row.input), preview: row.preview, status: row.status, created: row.created } : null;

export class State {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    // WAL + synchronous=NORMAL: a commit survives a crash of the bot; FULL would fsync on every
    // write (≈2.6 ms here, and every streamed answer chunk is a write), blocking every chat.
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=NORMAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS updates (id INTEGER PRIMARY KEY, payload TEXT NOT NULL, thread_id TEXT, status TEXT NOT NULL DEFAULT 'pending', created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, thread_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS files (id INTEGER PRIMARY KEY, thread_id TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS delivered (key TEXT PRIMARY KEY, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS turn_queue (
        id INTEGER PRIMARY KEY, thread_id TEXT NOT NULL, message_id INTEGER NOT NULL,
        input TEXT NOT NULL, preview TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'waiting', created INTEGER NOT NULL,
        UNIQUE(thread_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS topics (id INTEGER PRIMARY KEY, thread_id TEXT UNIQUE, value TEXT NOT NULL);
    `);
    // v1: chats live in private-chat topics; the global selected chat/draft no longer addresses input.
    if (this.db.prepare('PRAGMA user_version').get().user_version < 1) {
      this.db.exec("DELETE FROM settings WHERE key IN ('activeThread','activeDraft','activeProject','queueNext'); PRAGMA user_version=1;");
    }
  }
  get(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : fallback;
  }
  set(key, value) { this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run(key, JSON.stringify(value)); }
  chat(id) {
    if (!id) return null;
    const row = this.db.prepare('SELECT value FROM chats WHERE id=?').get(id);
    return row ? JSON.parse(row.value) : null;
  }
  saveChat(chat) {
    const value = { ...this.chat(chat.id), ...chat };
    this.db.prepare('INSERT OR REPLACE INTO chats VALUES (?,?)').run(chat.id, JSON.stringify(value));
    return value;
  }
  chats() { return this.db.prepare('SELECT value FROM chats').all().map(r => JSON.parse(r.value)); }
  enqueue(update, threadId = null) {
    return this.db.prepare('INSERT OR IGNORE INTO updates (id,payload,thread_id,created) VALUES (?,?,?,?)').run(update.update_id, JSON.stringify(update), threadId, Date.now()).changes > 0;
  }
  updateStatus(id, status) { this.db.prepare('UPDATE updates SET status=? WHERE id=?').run(status, id); }
  pending() { return this.db.prepare("SELECT * FROM updates WHERE status='pending' ORDER BY id").all().map(r => ({ ...r, payload: JSON.parse(r.payload) })); }
  recoverUpdates() {
    const uncertain = this.db.prepare("SELECT id FROM updates WHERE status='processing'").all();
    this.db.prepare("UPDATE updates SET status='interrupted' WHERE status='processing'").run();
    return uncertain.length;
  }
  queueTurn(threadId, { messageId, input, preview = '' }) {
    this.db.prepare('INSERT INTO turn_queue (thread_id,message_id,input,preview,created) VALUES (?,?,?,?,?) ON CONFLICT(thread_id,message_id) DO NOTHING').run(threadId, messageId, JSON.stringify(input), preview, Date.now());
    return queueRow(this.db.prepare('SELECT * FROM turn_queue WHERE thread_id=? AND message_id=?').get(threadId, messageId));
  }
  queuedTurns(threadId) {
    return this.db.prepare("SELECT * FROM turn_queue WHERE thread_id=? AND status IN ('waiting','dispatching','uncertain') ORDER BY id").all(threadId).map(queueRow);
  }
  queueItem(id) { return queueRow(this.db.prepare('SELECT * FROM turn_queue WHERE id=?').get(id)); }
  queueStatus(id, status) {
    if (!queueStatuses.has(status)) throw new Error('Invalid queued turn status.');
    return this.db.prepare('UPDATE turn_queue SET status=? WHERE id=?').run(status, id).changes > 0;
  }
  cancelQueued(id, threadId) {
    return this.db.prepare("UPDATE turn_queue SET status='cancelled' WHERE id=? AND thread_id=? AND status IN ('waiting','uncertain')").run(id, threadId).changes > 0;
  }
  recoverQueue() {
    return this.db.prepare("UPDATE turn_queue SET status='uncertain' WHERE status='dispatching' RETURNING *").all().map(queueRow).sort((a, b) => a.id - b.id);
  }
  // Bounded growth: processed updates, delivery markers, finished queue items and stale buttons.
  prune(now = Date.now()) {
    this.db.prepare("DELETE FROM updates WHERE status IN ('done','error','interrupted') AND created < ?").run(now - 7 * 86400000);
    this.db.prepare("DELETE FROM turn_queue WHERE status IN ('sent','cancelled','error') AND created < ?").run(now - 7 * 86400000);
    this.db.prepare('DELETE FROM delivered WHERE created < ?').run(now - 60 * 86400000);
    for (const row of this.db.prepare("SELECT key, value FROM settings WHERE key LIKE 'action:%'").all()) {
      if ((JSON.parse(row.value).at ?? 0) < now - 7 * 86400000) this.db.prepare('DELETE FROM settings WHERE key=?').run(row.key);
    }
  }
  topic(id) {
    const row = id ? this.db.prepare('SELECT * FROM topics WHERE id=?').get(id) : null;
    return row ? { ...JSON.parse(row.value), id: row.id, threadId: row.thread_id } : null;
  }
  topicForThread(threadId) {
    const row = threadId ? this.db.prepare('SELECT id FROM topics WHERE thread_id=?').get(threadId) : null;
    return row ? this.topic(row.id) : null;
  }
  saveTopic({ id, threadId, ...value }) {
    const previous = this.topic(id);
    const thread = threadId === undefined ? previous?.threadId ?? null : threadId;
    const { id: _id, threadId: _thread, ...rest } = previous ?? {};
    if (thread) this.db.prepare('DELETE FROM topics WHERE thread_id=? AND id<>?').run(thread, id);
    this.db.prepare('INSERT OR REPLACE INTO topics (id,thread_id,value) VALUES (?,?,?)').run(id, thread, JSON.stringify({ ...rest, ...value }));
    return this.topic(id);
  }
  topics() { return this.db.prepare('SELECT id FROM topics ORDER BY id').all().map(row => this.topic(row.id)); }
  deleteTopic(id) { this.db.prepare('DELETE FROM topics WHERE id=?').run(id); }
  hold(id) { this.updateStatus(id, 'held'); }
  isHeld(id, address) { return Boolean(this.db.prepare("SELECT 1 FROM updates WHERE id=? AND status='held' AND thread_id=?").get(id, address)); }
  held(address) { return this.db.prepare("SELECT id FROM updates WHERE status='held' AND thread_id=? ORDER BY id").all(address).map(r => r.id); }
  release(address, target) { return this.db.prepare("UPDATE updates SET status='pending', thread_id=? WHERE status='held' AND thread_id=?").run(target, address).changes; }
  unfinishedUpdates(threadId) { return this.db.prepare("SELECT count(*) AS n FROM updates WHERE thread_id=? AND status IN ('pending','processing','held')").get(threadId).n; }
  bind(messageId, threadId) { this.db.prepare('INSERT OR REPLACE INTO messages VALUES (?,?)').run(messageId, threadId); }
  threadForMessage(id) { return this.db.prepare('SELECT thread_id FROM messages WHERE id=?').get(id)?.thread_id; }
  addFile(threadId, value) {
    const id = Number(this.db.prepare('INSERT INTO files (thread_id,value) VALUES (?,?)').run(threadId, JSON.stringify(value)).lastInsertRowid);
    return { ...value, id };
  }
  files(threadId) { return this.db.prepare('SELECT id,value FROM files WHERE thread_id=? ORDER BY id DESC LIMIT 30').all(threadId).map(r => ({ ...JSON.parse(r.value), id: r.id })); }
  file(id) {
    const row = this.db.prepare('SELECT * FROM files WHERE id=?').get(id);
    return row ? { ...JSON.parse(row.value), id: row.id, threadId: row.thread_id } : null;
  }
  wasDelivered(key) { return Boolean(this.db.prepare('SELECT key FROM delivered WHERE key=?').get(key)); }
  delivered(key) { this.db.prepare('INSERT OR IGNORE INTO delivered VALUES (?,?)').run(key, Date.now()); }
  close() { this.db.close(); }
}

export function isOwner(update, ownerId) {
  const message = update.message ?? update.callback_query?.message;
  const sender = update.message?.from ?? update.callback_query?.from;
  return Boolean(message && sender && !sender.is_bot && sender.id === ownerId && message.chat?.type === 'private' && message.chat.id === ownerId);
}
