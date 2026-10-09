import http2 from "http2";
import net from "net";
import {
  encodeIntegerRFC7541,
  encodeStringLiteralsRFC7541,
  getHeadersFrame,
  http2ConnectionPreface,
} from "../utils.js";
import { getFileName } from "../utils.js";
import { serverOption } from "../server-option.js";
import assert from "assert";

const fileName = getFileName(import.meta.filename);
const { host, port, enableNodejsHttp2Server } = serverOption;

const config = {
  rfc: [
    {
      url: "https://datatracker.ietf.org/doc/html/rfc7541#section-4.4",
      description: `
        A new entry can reference the name of an entry in the dynamic table
        that will be evicted when adding this new entry into the dynamic
        table.  Implementations are cautioned to avoid deleting the
        referenced name if the referenced entry is evicted from the dynamic
        table prior to inserting the new entry.
      `,
    },
  ],
};

if (enableNodejsHttp2Server) {
  const http2Server = http2.createServer();
  http2Server.listen(port);
  http2Server.on("request", (req, res) => {
    assert(req.headers.key === "value01, value01, value02, value02");
    process.exit(0);
    // todo 其他 sever 要怎判斷正常回應？用 headers frame 嗎？
  });
}

const socket = net.connect({
  host,
  port,
  allowHalfOpen: false,
});
await http2ConnectionPreface(socket);
const headersFrame1 = getHeadersFrame({
  streamID: 1,
  flags: 5,
  fieldBlockFragment: Buffer.concat([
    encodeIntegerRFC7541({ prefix: "001", integer: 32 + 3 + 7 }),
    encodeIntegerRFC7541({ prefix: "1", integer: 2 }),
    encodeIntegerRFC7541({ prefix: "1", integer: 4 }),
    encodeIntegerRFC7541({ prefix: "1", integer: 6 }),

    encodeIntegerRFC7541({ prefix: "0001", integer: 1 }),
    encodeStringLiteralsRFC7541({ string: `${host}:${port}` }),

    // key: value01
    encodeIntegerRFC7541({ prefix: "01", integer: 0 }),
    encodeStringLiteralsRFC7541({ string: "key" }),
    encodeStringLiteralsRFC7541({ string: "value01" }),

    // key: value01
    encodeIntegerRFC7541({ prefix: "1", integer: 62 }),

    // key: value02 (reference-to-be-evicted-entry-name)
    encodeIntegerRFC7541({ prefix: "01", integer: 62 }),
    encodeStringLiteralsRFC7541({ string: "value02" }),

    // key: value02
    encodeIntegerRFC7541({ prefix: "1", integer: 62 }),
  ]),
});
socket.write(headersFrame1);
