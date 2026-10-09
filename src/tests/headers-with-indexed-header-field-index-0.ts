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
import assert from "assert";
import { getFileName, onceData } from "../utils.js";
import { serverOption } from "../server-option.js";

const fileName = getFileName(import.meta.filename);
const { host, port } = serverOption;

const config = {
  rfc: [
    {
      url: "https://datatracker.ietf.org/doc/html/rfc7541#section-6.1",
      description: `
        The index value of 0 is not used.  It MUST be treated as a decoding
        error if found in an indexed header field representation.
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
const goawayFrame = getGoawayFrame({
  lastStreamID: 1,
  errorCode: ERROR_CODES.COMPRESSION_ERROR,
});
const headersFrame = getHeadersFrame({
  streamID: 1,
  flags: 5,
  fieldBlockFragment: Buffer.concat([
    encodeIntegerRFC7541({ prefix: "1", integer: 2 }),
    encodeIntegerRFC7541({ prefix: "1", integer: 4 }),
    encodeIntegerRFC7541({ prefix: "1", integer: 6 }),

    // Indexed Header Field with index 0
    encodeIntegerRFC7541({ prefix: "1", integer: 0 }),

    encodeIntegerRFC7541({ prefix: "0001", integer: 1 }),
    encodeStringLiteralsRFC7541({
      string: `${host}:${port}`,
    }),
  ]),
});
socket.write(headersFrame);
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
