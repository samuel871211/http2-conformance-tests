import http2 from "http2";
import net from "net";
import {
  encodeIntegerRFC7541,
  encodeStringLiteralsRFC7541,
  getGoawayFrame,
  getHeadersFrame,
  http2ConnectionPreface,
  ERROR_CODES,
} from "../utils.js";
import { getFileName, onceData, writeAsync } from "../utils.js";
import assert from "assert";
import { serverOption } from "../server-option.js";

const fileName = getFileName(import.meta.filename);
const { host, port } = serverOption;

const config = {
  rfc: [
    {
      url: "https://datatracker.ietf.org/doc/html/rfc7541#section-4.3",
      description: `
        Whenever the maximum size for the dynamic table is reduced, entries
        are evicted from the end of the dynamic table until the size of the
        dynamic table is less than or equal to the maximum size.
      `,
    },
  ],
};

const http2Server = http2.createServer();
http2Server.listen(port);
http2Server.on("request", (req, res) => res.end());

const socket = net.connect({
  host,
  port,
  allowHalfOpen: false,
});
await http2ConnectionPreface(socket);
const headersFrame1 = getHeadersFrame({
  streamID: 1,
  flags: 5,
  fieldBlockFragment: Buffer.concat([
    encodeIntegerRFC7541({
      prefix: "001",
      integer: ("keyvalue".length + 32) * 2,
    }),

    encodeIntegerRFC7541({ prefix: "1", integer: 2 }),

    encodeIntegerRFC7541({ prefix: "1", integer: 4 }),

    encodeIntegerRFC7541({ prefix: "1", integer: 6 }),

    encodeIntegerRFC7541({ prefix: "0001", integer: 1 }),
    encodeStringLiteralsRFC7541({ string: `${host}:${port}` }),

    // 先塞滿 62, 63
    encodeIntegerRFC7541({ prefix: "01", integer: 0 }),
    encodeStringLiteralsRFC7541({ string: "key" }),
    encodeStringLiteralsRFC7541({ string: "value" }),

    encodeIntegerRFC7541({ prefix: "01", integer: 0 }),
    encodeStringLiteralsRFC7541({ string: "key" }),
    encodeStringLiteralsRFC7541({ string: "value" }),

    encodeIntegerRFC7541({ prefix: "1", integer: 62 }),
    encodeIntegerRFC7541({ prefix: "1", integer: 63 }),
  ]),
});
await writeAsync(socket, headersFrame1);
await onceData(socket);
const headersFrame2 = getHeadersFrame({
  streamID: 3,
  flags: 5,
  fieldBlockFragment: Buffer.concat([
    // 之後把 dynamic table size 調到 => 剛好塞得下 62 的大小
    encodeIntegerRFC7541({ prefix: "001", integer: "keyvalue".length + 32 }),

    encodeIntegerRFC7541({ prefix: "1", integer: 2 }),

    encodeIntegerRFC7541({ prefix: "1", integer: 4 }),

    encodeIntegerRFC7541({ prefix: "1", integer: 6 }),

    encodeIntegerRFC7541({ prefix: "0001", integer: 1 }),
    encodeStringLiteralsRFC7541({ string: `${host}:${port}` }),

    // 接著引用 63
    encodeIntegerRFC7541({ prefix: "1", integer: 63 }),
  ]),
});
await writeAsync(socket, headersFrame2);
// 確保不符合規範的 server 可以正確被偵測
socket.setTimeout(5000, () => {
  console.log(`${fileName}: server does not close the TCP connection`);
  process.exit(1);
});
const maybeGoawayFrame = await onceData(socket);
const goawayFrame = getGoawayFrame({
  lastStreamID: 3,
  errorCode: ERROR_CODES.COMPRESSION_ERROR,
});
// 理論上 server 會噴 goaway (compression error)
assert(maybeGoawayFrame.equals(goawayFrame));
socket.on("close", () => {
  console.log(`${fileName}: ok`);
  process.exit(0);
});
