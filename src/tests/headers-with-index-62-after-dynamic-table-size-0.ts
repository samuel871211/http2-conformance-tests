import http2 from "http2";
import net from "net";
import {
  encodeIntegerRFC7541,
  encodeStringLiteralsRFC7541,
  ERROR_CODES,
  getGoawayFrame,
  getHeadersFrame,
  http2ConnectionPreface,
} from "../utils.js";
import { getFileName, onceData } from "../utils.js";
import assert from "assert";
import { serverOption } from "../server-option.js";

const fileName = getFileName(import.meta.filename);
const { host, port, enableNodejsHttp2Server } = serverOption;

const config = {
  rfc: [
    {
      url: "https://datatracker.ietf.org/doc/html/rfc7541#section-4.2",
      description: `
        This mechanism can be used to completely clear entries from the
        dynamic table by setting a maximum size of 0
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
    encodeIntegerRFC7541({
      prefix: "001",
      integer: 0,
    }),

    encodeIntegerRFC7541({ prefix: "1", integer: 2 }),
    encodeIntegerRFC7541({ prefix: "1", integer: 4 }),
    encodeIntegerRFC7541({ prefix: "1", integer: 6 }),

    encodeIntegerRFC7541({ prefix: "0000", integer: 1 }),
    encodeStringLiteralsRFC7541({ string: `${host}:${port}` }),

    encodeIntegerRFC7541({ prefix: "01", integer: 0 }),
    encodeStringLiteralsRFC7541({ string: "x-test" }),
    encodeStringLiteralsRFC7541({ string: "a" }),

    encodeIntegerRFC7541({ prefix: "01", integer: 62 }),
    encodeStringLiteralsRFC7541({ string: "b" }),
  ]),
});
socket.write(headersFrame);
// 確保不符合規範的 server 可以正確被偵測
socket.setTimeout(5000, () => {
  console.log(`${fileName}: server does not close the TCP connection`);
  process.exit(1);
});
const maybeGoawayFrame = await onceData(socket);
const goawayFrame = getGoawayFrame({
  lastStreamID: 1,
  errorCode: ERROR_CODES.COMPRESSION_ERROR,
});
assert(maybeGoawayFrame.equals(goawayFrame));
socket.on("close", () => {
  console.log(`${fileName}: ok`);
  process.exit(0);
});
