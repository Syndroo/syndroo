import { Duplex } from "node:stream";

/** A socket below Node's real HTTP serializer/parser; it never opens a handle. */
export class ScriptedSocket extends Duplex {
  readonly remoteAddress: string;
  readonly encrypted = true;
  readonly authorized: boolean;
  readonly writes: Buffer[] = [];
  private replied = false;

  constructor(
    private readonly reply?: string | ((socket: ScriptedSocket) => void),
    address = "93.184.216.34",
    authorized = true,
  ) {
    super();
    this.remoteAddress = address;
    this.authorized = authorized;
  }

  get sent(): string { return Buffer.concat(this.writes).toString("utf8"); }

  override _read(): void {}

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    this.writes.push(Buffer.from(chunk));
    done();
    const split = this.sent.indexOf("\r\n\r\n");
    const length = Number(/content-length: (\d+)/i.exec(this.sent)?.[1] ?? 0);
    if (this.replied || split < 0 || Buffer.byteLength(this.sent.slice(split + 4)) < length) return;
    this.replied = true;
    queueMicrotask(() => {
      if (this.destroyed) return;
      if (typeof this.reply === "function") this.reply(this);
      else if (this.reply !== undefined) {
        this.push(Buffer.from(this.reply));
        this.push(null);
      }
    });
  }
}

export const OK = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok";
