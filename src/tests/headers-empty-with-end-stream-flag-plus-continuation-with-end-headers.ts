import http2 from "http2";
import net from "net";
import {
  encodeIntegerRFC7541,
  encodeStringLiteralsRFC7541,
  getHeadersFrame,
  http2ConnectionPreface,
} from "../utils.js";
import assert from "assert";
import { writeAsync } from "../utils.js";
import { serverOption } from "../server-option.js";
import { getFileName } from "../utils.js";

const fileName = getFileName(import.meta.filename);
const { host, port } = serverOption;

const config = {
  rfc: [
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-6.2",
      description: `
        However, a HEADERS frame with the END_STREAM flag set can be followed
        by CONTINUATION frames on the same stream.
      `,
    },
  ],
};

const http2Server = http2.createServer();
http2Server.on("stream", (stream, headers, flags, rawHeaders) => {
  assert(flags === 5);
  console.log(`${fileName}: ok`);
  process.exit(0);
});
http2Server.listen(port);

const socket = net.connect({
  host,
  port,
  allowHalfOpen: false,
});
await http2ConnectionPreface(socket);
const emptyHeadersFrameWithEndStreamFlag = getHeadersFrame({
  streamID: 1,
  flags: 1,
  fieldBlockFragment: Buffer.alloc(0),
});
await writeAsync(socket, emptyHeadersFrameWithEndStreamFlag);
const headersFrame = getHeadersFrame({
  streamID: 1,
  flags: 4,
  isContinuationFrame: true,
  fieldBlockFragment: Buffer.concat([
    encodeIntegerRFC7541({ prefix: "1", integer: 2 }),
    encodeIntegerRFC7541({ prefix: "1", integer: 4 }),
    encodeIntegerRFC7541({ prefix: "1", integer: 6 }),
    encodeIntegerRFC7541({ prefix: "0001", integer: 1 }),
    encodeStringLiteralsRFC7541({ string: `${host}:${port}` }),
  ]),
});
socket.write(headersFrame);
