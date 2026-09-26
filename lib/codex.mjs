import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

// Control socket of the local `codex app-server daemon` (CODEX_HOME defaults to ~/.codex).
export function defaultSocketPath(env = process.env) {
  return join(env.CODEX_HOME || join(homedir(), '.codex'), 'app-server-control', 'app-server-control.sock');
}

export class CodexRpcError extends Error {
  constructor(error, method) {
    super(error.message || 'Codex request failed');
    this.name = 'CodexRpcError';
    this.code = error.code;
    this.data = error.data;
    this.method = method;
  }
}

// The daemon control socket carries WebSocket frames, unlike app-server stdio.
export class CodexClient extends EventEmitter {
  #socket;
  #connecting;
  #ready = false;
  #nextId = 0;
  #pending = new Map();
  #intentionalClose = false;

  constructor({
    socketPath = defaultSocketPath(),
    timeoutMs = 30_000,
    handshakeTimeoutMs = 10_000,
    clientName = 'codex_telegram',
    clientVersion = '0.1.0',
  } = {}) {
    super();
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    this.clientInfo = { name: clientName, version: clientVersion };
  }

  get connected() {
    return this.#ready && this.#socket?.readyState === WebSocket.OPEN;
  }

  async connect() {
    if (this.connected) return;
    if (this.#connecting) return this.#connecting;
    this.#connecting = this.#open();
    try {
      await this.#connecting;
    } finally {
      this.#connecting = undefined;
    }
  }

  async #open() {
    this.#intentionalClose = false;
    const socket = new WebSocket(`ws+unix://${this.socketPath}:/`, {
      handshakeTimeout: this.handshakeTimeoutMs,
      perMessageDeflate: false,
      maxPayload: 64 * 1024 * 1024,
    });
    this.#socket = socket;
    let transportError;
    socket.on('error', error => { transportError = error; });
    socket.on('message', data => {
      if (socket !== this.#socket) return;
      let message;
      try {
        message = JSON.parse(data.toString());
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
          throw new Error('Invalid RPC envelope');
        }
      } catch {
        transportError = new Error('Codex sent an invalid JSON-RPC message');
        socket.terminate();
        return;
      }
      if (typeof message.method === 'string') {
        if (Object.hasOwn(message, 'id')) this.emit('request', message);
        else this.emit('notification', message.method, message.params);
        return;
      }
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new CodexRpcError(message.error, pending.method));
      else pending.resolve(message.result);
    });
    socket.on('close', code => {
      if (socket !== this.#socket) return;
      this.#ready = false;
      this.#socket = undefined;
      const error = transportError || new Error(`Codex connection closed (${code})`);
      error.intentional = this.#intentionalClose;
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.#pending.clear();
      this.emit('disconnect', error);
    });
    try {
      await new Promise((resolve, reject) => {
        const opened = () => { cleanup(); resolve(); };
        const failed = error => { cleanup(); reject(error); };
        const closed = () => failed(new Error('Codex closed during connection setup'));
        const cleanup = () => {
          socket.off('open', opened);
          socket.off('error', failed);
          socket.off('close', closed);
        };
        socket.once('open', opened);
        socket.once('error', failed);
        socket.once('close', closed);
      });
      await this.#request('initialize', {
        clientInfo: this.clientInfo,
        capabilities: { experimentalApi: true },
      }, this.handshakeTimeoutMs);
      this.#send({ method: 'initialized', params: {} });
      this.#ready = true;
    } catch (error) {
      socket.terminate();
      throw error;
    }
  }

  request(method, params = {}, { timeoutMs = this.timeoutMs } = {}) {
    if (!this.connected) return Promise.reject(new Error('Codex is not connected'));
    return this.#request(method, params, timeoutMs);
  }

  #request(method, params, timeoutMs) {
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        const error = new Error(`Codex request timed out: ${method}`);
        error.code = 'CODEX_REQUEST_TIMEOUT';
        error.method = method;
        reject(error);
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, method });
      try {
        this.#send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  respond(id, result) {
    this.#send({ id, result });
  }

  reject(id, error) {
    this.#send({ id, error: {
      code: error.code ?? -32603,
      message: error.message || 'Client could not complete this request',
      ...(error.data === undefined ? {} : { data: error.data }),
    } });
  }

  #send(message) {
    if (this.#socket?.readyState !== WebSocket.OPEN) throw new Error('Codex is not connected');
    this.#socket.send(JSON.stringify(message));
  }

  async close() {
    const socket = this.#socket;
    if (!socket) return;
    this.#intentionalClose = true;
    this.#ready = false;
    await new Promise(resolve => {
      const timer = setTimeout(() => socket.terminate(), 1_000);
      socket.once('close', () => { clearTimeout(timer); resolve(); });
      if (socket.readyState === WebSocket.OPEN) socket.close();
      else socket.terminate();
    });
  }
}
