/*
 * Bun 1.2.19에는 CompressionStream/DecompressionStream이 없다.
 * 없으면 원본 share.ts가 압축 없는 링크를 만들어 공식 MCP(Node) 링크와 달라진다.
 * Node의 구현과 같은 zlib 기본 설정(deflate-raw)으로 채운다. 이미 있으면 건드리지 않는다.
 * 반드시 원본 모듈보다 먼저 import할 것.
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';

type Format = 'deflate-raw';

function collector(convert: (b: Buffer) => Buffer): TransformStream<Uint8Array, Uint8Array> {
  const chunks: Uint8Array[] = [];
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk) {
      chunks.push(chunk);
    },
    flush(controller) {
      controller.enqueue(new Uint8Array(convert(Buffer.concat(chunks))));
    },
  });
}

if (typeof globalThis.CompressionStream !== 'function') {
  class LabCompressionStream {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
    constructor(format: Format) {
      if (format !== 'deflate-raw') throw new TypeError(`unsupported format ${format}`);
      const t = collector((b) => deflateRawSync(b));
      this.readable = t.readable;
      this.writable = t.writable;
    }
  }
  class LabDecompressionStream {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
    constructor(format: Format) {
      if (format !== 'deflate-raw') throw new TypeError(`unsupported format ${format}`);
      const t = collector((b) => inflateRawSync(b));
      this.readable = t.readable;
      this.writable = t.writable;
    }
  }
  (globalThis as Record<string, unknown>).CompressionStream = LabCompressionStream;
  (globalThis as Record<string, unknown>).DecompressionStream = LabDecompressionStream;
}
