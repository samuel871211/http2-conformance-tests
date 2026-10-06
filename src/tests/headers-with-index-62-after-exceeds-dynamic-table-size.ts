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

const config = {
  rfc: [
    {
      url: "https://datatracker.ietf.org/doc/html/rfc7541#section-4.4",
      description: `
        an
        attempt to add an entry larger than the maximum size causes the table
        to be emptied of all existing entries and results in an empty table.
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

const http2Server = http2.createServer();
http2Server.listen(serverOption.port);

const socket = net.connect({
  host: serverOption.host,
  port: serverOption.port,
  allowHalfOpen: false,
});
await http2ConnectionPreface(socket);
const headersFrame = getHeadersFrame({
  streamID: 1,
  flags: 5,
  fieldBlockFragment: Buffer.concat([
    encodeIntegerRFC7541({
      prefix: "001",
      integer: 32 + 6 + 1,
    }),

    encodeIntegerRFC7541({ prefix: "1", integer: 2 }),
    encodeIntegerRFC7541({ prefix: "1", integer: 4 }),
    encodeIntegerRFC7541({ prefix: "1", integer: 6 }),

    // Literal Header Field without Indexing { name: ":authority", value: "localhost:5000" }
    encodeIntegerRFC7541({ prefix: "0000", integer: 1 }),
    encodeStringLiteralsRFC7541({
      string: `${serverOption.host}:${serverOption.port}`,
    }),

    // Literal Header Field with Incremental Indexing { name: "x-test", value: "a" }
    encodeIntegerRFC7541({ prefix: "01", integer: 0 }),
    encodeStringLiteralsRFC7541({ string: "x-test" }),
    encodeStringLiteralsRFC7541({ string: "a" }),

    // Literal Header Field with Incremental Indexing { name: "x-test", value: "b" }
    encodeIntegerRFC7541({ prefix: "01", integer: 62 }),
    encodeStringLiteralsRFC7541({ string: "b" }),

    // Literal Header Field with Incremental Indexing { name: "x-test", value: "bb" }
    encodeIntegerRFC7541({ prefix: "01", integer: 62 }),
    encodeStringLiteralsRFC7541({ string: "bb" }),

    // Literal Header Field with Incremental Indexing { name: "x-test", value: "c" }
    encodeIntegerRFC7541({ prefix: "01", integer: 62 }),
    encodeStringLiteralsRFC7541({ string: "c" }),
  ]),
});
socket.write(headersFrame);
const goawayFrame = getGoawayFrame({
  lastStreamID: 1,
  errorCode: ERROR_CODES.COMPRESSION_ERROR,
});
// 確保不符合規範的 server 可以正確被偵測
socket.setTimeout(5000, () => {
  console.log(`${fileName}: server does not close the TCP connection`);
  process.exit(1);
});
const maybeGoawayFrame = await onceData(socket);
assert(maybeGoawayFrame.equals(goawayFrame));
socket.on("close", () => {
  console.log(`${fileName}: ok`);
  process.exit(0);
});
