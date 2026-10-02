import net from 'node:net';

export class HerdrError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'HerdrError';
    this.code = code;
  }
}

let counter = 0;

export function createClient({ socketPath = process.env.HERDR_SOCKET_PATH, timeoutMs = 5000 } = {}) {
  if (!socketPath) throw new Error('HERDR_SOCKET_PATH is not set; run this inside herdr');

  function call(method, params = {}) {
    const id = `herdr-space-parking:${process.pid}:${++counter}`;
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      let buffer = '';
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        fn(value);
      };
      const timer = setTimeout(
        () => finish(reject, new HerdrError('timeout', `${method} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      socket.setEncoding('utf8');
      socket.on('connect', () => socket.write(JSON.stringify({ id, method, params }) + '\n'));
      socket.on('data', (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf('\n');
        if (newline === -1) return;
        let message;
        try {
          message = JSON.parse(buffer.slice(0, newline));
        } catch (err) {
          finish(reject, new HerdrError('bad_response', err.message));
          return;
        }
        if (message.error) finish(reject, new HerdrError(message.error.code, message.error.message));
        else finish(resolve, message.result);
      });
      socket.on('error', (err) => finish(reject, new HerdrError('socket_error', err.message)));
      socket.on('close', () => finish(reject, new HerdrError('socket_closed', `${method}: connection closed without a response`)));
    });
  }

  return { call };
}
