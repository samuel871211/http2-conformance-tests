import http2 from "http2";
import net from "net";
import assert from "assert";
import { serverOption } from "../server-option.js";
import {
  encodeIntegerRFC7541,
  encodeStringLiteralsRFC7541,
  getHeadersFrame,
  http2ConnectionPreface,
} from "../utils.js";
import { getFileName } from "../utils.js";

const fileName = getFileName(import.meta.filename);

const config = {
  rfc: [
    {
      url: "https://datatracker.ietf.org/doc/html/rfc7541#section-2.3.2",
      description: `
        The dynamic table can contain duplicate entries (i.e., entries with
        the same name and same value).  Therefore, duplicate entries MUST NOT
        be treated as an error by a decoder.
      `,
    },
  ],
};

const http2Server = http2.createServer();
http2Server.listen(serverOption.port);
http2Server.on("request", (req, res) => {
  assert(req.rawHeaders.filter((str) => str === "x-custom-key").length === 4);
  console.log(`${fileName}: ok`);
});

const socket = net.connect({
  host: serverOption.host,
  port: serverOption.port,
  allowHalfOpen: true,
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
    encodeStringLiteralsRFC7541({ string: "localhost:5001" }),

    // 存第一次
    encodeIntegerRFC7541({ prefix: "01", integer: 0 }),
    encodeStringLiteralsRFC7541({ string: "x-custom-key" }),
    encodeStringLiteralsRFC7541({ string: "x-custom-value" }),

    // 存第二次
    encodeIntegerRFC7541({ prefix: "01", integer: 0 }),
    encodeStringLiteralsRFC7541({ string: "x-custom-key" }),
    encodeStringLiteralsRFC7541({ string: "x-custom-value" }),

    // 引用第一個
    encodeIntegerRFC7541({ prefix: "1", integer: 62 }),

    // 引用第二個
    encodeIntegerRFC7541({ prefix: "1", integer: 63 }),
  ]),
});
socket.write(headersFrame);
