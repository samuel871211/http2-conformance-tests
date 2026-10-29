import http2 from "http2";
import net from "net";
import {
  encodeIntegerRFC7541,
  encodeStringLiteralsRFC7541,
  ERROR_CODES,
  getGoawayFrame,
  getHeadersFrame,
  http2ConnectionPreface,
  readHttp2Frame,
  readHttp2FramesUntil,
  readUntilEndStream,
} from "../utils.js";
import { getFileName } from "../utils.js";
import assert from "assert";
import { serverOption } from "../server-option.js";

const fileName = getFileName(import.meta.filename);
const { host, port, enableNodejsHttp2Server } = serverOption;

const config = {
  rfc: [
    {
      url: "https://datatracker.ietf.org/doc/html/rfc7541#section-6.2.3",
      description: `
        A literal header field never-indexed representation results in appending a header field to the decoded header list without altering the dynamic table.
      `,
    },
    {
      url: "https://datatracker.ietf.org/doc/html/rfc7541#section-2.3.3",
      description: `
        Indices strictly greater than the sum of the lengths of both tables
        MUST be treated as a decoding error.
      `,
    },
  ],
};

if (enableNodejsHttp2Server) {
  const http2Server = http2.createServer();
  http2Server.listen(port);
  http2Server.on("stream", (stream) => {
    stream.respond();
    stream.end();
  });
}

const socket = net.connect({
  host,
  port,
  allowHalfOpen: false,
});
await http2ConnectionPreface(socket);
const headersFrame = getHeadersFrame({
  streamID: 1,
  flags: 5,
  fieldBlockFragment: Buffer.concat([
    encodeIntegerRFC7541({ prefix: "1", integer: 2 }),
    encodeIntegerRFC7541({ prefix: "1", integer: 4 }),
    encodeIntegerRFC7541({ prefix: "1", integer: 6 }),

    encodeIntegerRFC7541({ prefix: "0001", integer: 1 }),
    encodeStringLiteralsRFC7541({ string: `${host}:${port}` }),

    // Literal Header Field Never Indexed
    encodeIntegerRFC7541({ prefix: "0001", integer: 0 }),
    encodeStringLiteralsRFC7541({ string: "x-test" }),
    encodeStringLiteralsRFC7541({ string: "1" }),
  ]),
});
socket.write(headersFrame);
await readHttp2FramesUntil({
  socket,
  predicate: (http2Frame) => readUntilEndStream({ http2Frame, streamID: 1 }),
});

// 上一個 request 的 literal 不應該進入 dynamic table，所以 index 62 不存在
const headersFrame2 = getHeadersFrame({
  streamID: 3,
  flags: 5,
  fieldBlockFragment: Buffer.concat([
    encodeIntegerRFC7541({ prefix: "1", integer: 2 }),
    encodeIntegerRFC7541({ prefix: "1", integer: 4 }),
    encodeIntegerRFC7541({ prefix: "1", integer: 6 }),

    encodeIntegerRFC7541({ prefix: "0001", integer: 1 }),
    encodeStringLiteralsRFC7541({ string: `${host}:${port}` }),

    encodeIntegerRFC7541({ prefix: "1", integer: 62 }),
  ]),
});
socket.write(headersFrame2);
// 確保不符合規範的 server 可以正確被偵測
socket.setTimeout(5000, () => {
  console.log(`${fileName}: server does not close the TCP connection`);
  process.exit(1);
});
const maybeGoawayFrame = await readHttp2Frame(socket);
const goawayFrame = getGoawayFrame({
  lastStreamID: 3,
  errorCode: ERROR_CODES.COMPRESSION_ERROR,
});
assert(maybeGoawayFrame.raw.equals(goawayFrame));
socket.on("close", () => {
  console.log(`${fileName}: ok`);
  process.exit(0);
});
