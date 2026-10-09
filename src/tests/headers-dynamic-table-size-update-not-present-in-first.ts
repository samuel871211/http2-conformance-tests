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
import { getFileName, onceData } from "../utils.js";
import assert from "assert";
import { serverOption } from "../server-option.js";

const fileName = getFileName(import.meta.filename);
const { host, port } = serverOption;

const config = {
  rfc: [
    {
      url: "https://datatracker.ietf.org/doc/html/rfc7541#section-4.2",
      description: `
        A change in the maximum size of the dynamic table is signaled via a
        dynamic table size update (see Section 6.3).  This dynamic table size
        update MUST occur at the beginning of the first header block
        following the change to the dynamic table size.  In HTTP/2, this
        follows a settings acknowledgment (see Section 6.5.3 of [HTTP2]).
      `,
    },
  ],
};

const http2Server = http2.createServer();
http2Server.listen(port);

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
    encodeStringLiteralsRFC7541({
      string: `${host}:${port}`,
    }),

    // dynamic-table-size-update-not-present-in-first
    encodeIntegerRFC7541({ prefix: "001", integer: 32 }),
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
  process.exit();
});
