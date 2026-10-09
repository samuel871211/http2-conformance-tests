import net from "net";
import http2 from "http2";
import {
  getRSTFrame,
  http2ConnectionPreface,
  ERROR_CODES,
  getHeadersFrame,
  encodeIntegerRFC7541,
  encodeStringLiteralsRFC7541,
} from "../utils.js";
import assert from "assert";
import { serverOption } from "../server-option.js";
import { onceData } from "../utils.js";
import { getFileName } from "../utils.js";

const fileName = getFileName(import.meta.filename);
const { host, port } = serverOption;

const config = {
  rfc: [
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-8.2.1",
      description: `
        A field name MUST NOT contain characters in the ranges 0x00-0x20,
        0x41-0x5a, or 0x7f-0xff (all ranges inclusive).  This specifically
        excludes all non-visible ASCII characters, ASCII SP (0x20), and
        uppercase characters ('A' to 'Z', ASCII 0x41 to 0x5a).
      `,
    },
  ],
};

const http2Server = http2.createServer();
http2Server.listen(port);
http2Server.on("stream", () =>
  assert(false, `Should not trigger http2Server.on("stream")`),
);
const socket = net.connect({
  host,
  port,
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

    encodeIntegerRFC7541({ prefix: "0001", integer: 0 }),
    encodeStringLiteralsRFC7541({ string: "TEST" }),
    encodeStringLiteralsRFC7541({ string: "123" }),
  ]),
});
socket.write(headersFrame);
const maybeRSTFrame = await onceData(socket);
const rstFrame = getRSTFrame({
  streamID: 1,
  errorCode: ERROR_CODES.PROTOCOL_ERROR,
});
assert(maybeRSTFrame.equals(rstFrame));
console.log(`${fileName}: ok`);
process.exit(0);
