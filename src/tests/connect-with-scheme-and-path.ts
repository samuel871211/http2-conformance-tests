import http2 from "http2";
import net from "net";
import assert from "assert";
import {
  http2ConnectionPreface,
  getHeadersFrame,
  getRSTFrame,
  encodeIntegerRFC7541,
  encodeStringLiteralsRFC7541,
  ERROR_CODES,
} from "../utils.js";
import { sleep } from "../utils.js";
import { serverOption } from "../server-option.js";
import { getFileName } from "../utils.js";

const fileName = getFileName(import.meta.filename);
const { host, port, enableNodejsHttp2Server } = serverOption;

const config = {
  rfc: [
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-8.5",
      description: `
        The ":scheme" and ":path" pseudo-header fields MUST be omitted.
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
const rstFrame = getRSTFrame({
  streamID: 1,
  errorCode: ERROR_CODES.PROTOCOL_ERROR,
});
const headersFrame = getHeadersFrame({
  streamID: 1,
  flags: 5,
  fieldBlockFragment: Buffer.concat([
    encodeIntegerRFC7541({ prefix: "0001", integer: 2 }),
    encodeStringLiteralsRFC7541({ string: "CONNECT" }),
    encodeIntegerRFC7541({ prefix: "1", integer: 4 }),
    encodeIntegerRFC7541({ prefix: "1", integer: 6 }),

    encodeIntegerRFC7541({ prefix: "0001", integer: 1 }),
    encodeStringLiteralsRFC7541({ string: `${host}:${port}` }),
  ]),
});
socket.write(headersFrame);
socket.on("close", () => assert(false));
socket.on("error", () => assert(false));
socket.on("data", (chunk) => assert(chunk.equals(rstFrame)));
await sleep(3000);
console.log(`${fileName}: ok`);
process.exit(0);
