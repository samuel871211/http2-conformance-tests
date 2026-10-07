import net from "net";
import http2 from "http2";
import {
  http2ConnectionPreface,
  getHeadersFrame,
  encodeIntegerRFC7541,
  encodeStringLiteralsRFC7541,
} from "../utils.js";
import assert from "assert";
import { serverOption } from "../server-option.js";
import { getFileName } from "../utils.js";

const fileName = getFileName(import.meta.filename);

const config = {
  rfc: [
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-8.2.1",
      description: `
        A field value MUST NOT start or end with an ASCII whitespace
        character (ASCII SP or HTAB, 0x20 or 0x09).
      `,
    },
  ],
};

const http2Server = http2.createServer({
  strictFieldWhitespaceValidation: false,
});
http2Server.listen(serverOption.port);
http2Server.on("stream", (stream, headers) => {
  assert(headers.hello === "world ");
  console.log(`${fileName}: ok`);
  process.exit(0);
});
const socket = net.connect({
  host: serverOption.host,
  port: serverOption.port,
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
      string: `${serverOption.host}:${serverOption.port}`,
    }),

    encodeIntegerRFC7541({ prefix: "0001", integer: 0 }),
    encodeStringLiteralsRFC7541({ string: "hello" }),
    encodeStringLiteralsRFC7541({ string: "world " }),
  ]),
});
socket.write(headersFrame);
