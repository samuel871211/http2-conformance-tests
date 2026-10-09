import http2 from "http2";
import net from "net";
import {
  encodeOverlongIntegerRFC7541,
  encodeIntegerRFC7541,
  encodeStringLiteralsRFC7541,
  getHeadersFrame,
  http2ConnectionPreface,
  getGoawayFrame,
  ERROR_CODES,
} from "../utils.js";
import { getFileName, onceData, writeAsync } from "../utils.js";
import { serverOption } from "../server-option.js";
import assert from "assert";

const fileName = getFileName(import.meta.filename);
const { host, port, enableNodejsHttp2Server } = serverOption;

const config = {
  rfc: [
    {
      url: "https://datatracker.ietf.org/doc/html/rfc7541#section-4.2",
      description: `
        It
        is also possible for an encoder to send a large number of zero
        values, which can waste octets and could be used to overflow integer
        values.  Integer encodings that exceed implementation limits -- in
        value or octet length -- MUST be treated as decoding errors.
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
    encodeIntegerRFC7541({ prefix: "1", integer: 2 }),

    encodeIntegerRFC7541({ prefix: "1", integer: 4 }),

    encodeIntegerRFC7541({ prefix: "1", integer: 6 }),

    encodeIntegerRFC7541({ prefix: "0001", integer: 1 }),
    encodeStringLiteralsRFC7541({ string: `${host}:${port}` }),

    // 總共用 7 bytes 來 encode integer，nghttp2 會噴 decoding error
    encodeOverlongIntegerRFC7541({
      prefix: "0001",
      integer: 58,
      additionalBytesCount: 5,
    }),
    encodeStringLiteralsRFC7541({ string: "Mozilla/5.0" }),
  ]),
});
await writeAsync(socket, headersFrame);
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
