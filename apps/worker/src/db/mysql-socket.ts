import { Buffer } from 'node:buffer';
import type { Duplex } from 'node:stream';

export const MYSQL_SOCKET_WRITE_BYTES = 32 * 1024;
type WriteCallback = (error?: Error | null) => void;

// Production Workers can drop TCP connections on a single write above 64 KiB:
// https://github.com/cloudflare/workerd/issues/7074
// Split transport writes, not MySQL packets, statements, or upload parts. Both
// hooks are needed: Writable can otherwise coalesce buffered chunks via _writev.
export function limitMysqlSocketWrites(socket: Duplex): void {
  const write = socket._write.bind(socket);
  const writeChunk = (chunk: Buffer | string, encoding: BufferEncoding, callback: WriteCallback): void => {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk;
    if (bytes.length <= MYSQL_SOCKET_WRITE_BYTES) {
      write(bytes, encoding, callback);
      return;
    }
    let offset = 0;
    const next: WriteCallback = (error) => {
      if (error) { callback(error); return; }
      if (offset === bytes.length) { callback(); return; }
      const end = Math.min(offset + MYSQL_SOCKET_WRITE_BYTES, bytes.length);
      const part = bytes.subarray(offset, end);
      offset = end;
      write(part, encoding, next);
    };
    next();
  };
  socket._write = writeChunk;
  socket._writev = (chunks, callback) => {
    let index = 0;
    const next: WriteCallback = (error) => {
      if (error) { callback(error); return; }
      const entry = chunks[index++];
      if (!entry) { callback(); return; }
      writeChunk(entry.chunk, entry.encoding, next);
    };
    next();
  };
}
