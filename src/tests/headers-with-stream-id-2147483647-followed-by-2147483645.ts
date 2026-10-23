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
import { serverOption } from "../server-option.js";
import assert from "assert";

const fileName = getFileName(import.meta.filename);
const { host, port, enableNodejsHttp2Server } = serverOption;

const config = {
  rfc: [
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-5.1.1",
      description: `
        The identifier of a newly established stream MUST be numerically
        greater than all streams that the initiating endpoint has opened or
        reserved. This governs streams that are opened using a HEADERS frame
        and streams that are reserved using PUSH_PROMISE. An endpoint that
        receives an unexpected stream identifier MUST respond with a
        connection error (Section 5.4.1) of type PROTOCOL_ERROR.
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
const streamID = Math.pow(2, 31) - 1;
await http2ConnectionPreface(socket);
const headersFrame = getHeadersFrame({
  streamID,
  flags: 5,
  fieldBlockFragment: Buffer.concat([
    encodeIntegerRFC7541({ prefix: "1", integer: 2 }),
    encodeIntegerRFC7541({ prefix: "1", integer: 4 }),
    encodeIntegerRFC7541({ prefix: "1", integer: 6 }),

    encodeIntegerRFC7541({ prefix: "0001", integer: 1 }),
    encodeStringLiteralsRFC7541({ string: `${host}:${port}` }),
  ]),
});
socket.write(headersFrame);
await readHttp2FramesUntil({
  socket,
  predicate: (http2Frame) => readUntilEndStream({ http2Frame, streamID }),
});
const headersFrame2 = getHeadersFrame({
  streamID: streamID - 2,
  flags: 5,
  fieldBlockFragment: Buffer.concat([
    encodeIntegerRFC7541({ prefix: "1", integer: 2 }),
    encodeIntegerRFC7541({ prefix: "1", integer: 4 }),
    encodeIntegerRFC7541({ prefix: "1", integer: 6 }),

    encodeIntegerRFC7541({ prefix: "0001", integer: 1 }),
    encodeStringLiteralsRFC7541({ string: `${host}:${port}` }),
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
  lastStreamID: streamID - 2,
  errorCode: ERROR_CODES.PROTOCOL_ERROR,
});
assert(maybeGoawayFrame.raw.equals(goawayFrame));
socket.on("close", () => {
  console.log(`${fileName}: ok`);
  process.exit(0);
});
