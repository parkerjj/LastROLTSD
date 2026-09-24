import { Buffer } from 'node:buffer';
import { Duplex } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { limitMysqlSocketWrites, MYSQL_SOCKET_WRITE_BYTES } from '../src/db/mysql-socket';

function recordingSocket(failAt?: number) {
  const writes: Buffer[] = [];
  const failure = new Error('socket write failed');
  const socket = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      writes.push(chunk);
      queueMicrotask(() => callback(writes.length === failAt ? failure : undefined));
    },
    writev(_chunks, callback) { callback(new Error('unbounded vector write must not be used')); },
  });
  socket.on('error', () => undefined);
  limitMysqlSocketWrites(socket);
  return { socket, writes, failure };
}

const write = (socket: Duplex, bytes: Buffer): Promise<void> => new Promise((resolve, reject) => {
  socket.write(bytes, (error) => error ? reject(error) : resolve());
});

describe('MySQL socket transport', () => {
  it.each([0, 1, 32768, 32769, 65536, 65537, 120000, 524288])('preserves all %i bytes while bounding each network write', async (size) => {
    const { socket, writes } = recordingSocket();
    const payload = Buffer.alloc(size);
    for (let index = 0; index < size; index++) payload[index] = index % 251;
    await write(socket, payload);
    expect(Buffer.concat(writes)).toEqual(payload);
    expect(writes.every((chunk) => chunk.length <= MYSQL_SOCKET_WRITE_BYTES)).toBe(true);
    if (size > MYSQL_SOCKET_WRITE_BYTES) expect(writes[0]!.buffer).toBe(payload.buffer);
    socket.destroy();
  });

  it('keeps buffered packet headers and bodies ordered without coalescing into an oversized write', async () => {
    const { socket, writes } = recordingSocket();
    const packets = [Buffer.from([1, 2, 3, 4]), Buffer.alloc(90000, 5), Buffer.alloc(70000, 6)];
    socket.cork();
    const pending = packets.map((packet) => write(socket, packet));
    socket.uncork();
    await Promise.all(pending);
    expect(Buffer.concat(writes)).toEqual(Buffer.concat(packets));
    expect(writes.every((chunk) => chunk.length <= MYSQL_SOCKET_WRITE_BYTES)).toBe(true);
    socket.destroy();
  });

  it('propagates a write failure and stops sending the remainder of a packet', async () => {
    const { socket, writes, failure } = recordingSocket(2);
    await expect(write(socket, Buffer.alloc(120000))).rejects.toBe(failure);
    expect(writes).toHaveLength(2);
    socket.destroy();
  });
});
