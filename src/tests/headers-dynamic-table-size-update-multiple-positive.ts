import http2 from "http2";
import net from "net";
import {
  encodeIntegerRFC7541,
  encodeStringLiteralsRFC7541,
  getHeadersFrame,
  http2ConnectionPreface,
  readHttp2FramesUntil,
  readUntilEndStream,
} from "../utils.js";
import { getFileName, writeAsync } from "../utils.js";
import { serverOption } from "../server-option.js";

const fileName = getFileName(import.meta.filename);
const { host, port, enableNodejsHttp2Server } = serverOption;

const config = {
  rfc: [
    {
      url: "https://datatracker.ietf.org/doc/html/rfc7541#section-4.3",
      description: `
        Whenever the maximum size for the dynamic table is reduced, entries
        are evicted from the end of the dynamic table until the size of the
        dynamic table is less than or equal to the maximum size.
      `,
    },
  ],
};

if (enableNodejsHttp2Server) {
  const http2Server = http2.createServer();
  http2Server.listen(port);
  http2Server.on("request", (req, res) => res.end("whatever"));
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
    encodeIntegerRFC7541({
      prefix: "001",
      integer: (32 + "keyvalue".length) * 2,
    }),
    encodeIntegerRFC7541({ prefix: "1", integer: 2 }),
    encodeIntegerRFC7541({ prefix: "1", integer: 4 }),
    encodeIntegerRFC7541({ prefix: "1", integer: 6 }),
    encodeIntegerRFC7541({ prefix: "0001", integer: 1 }),
    encodeStringLiteralsRFC7541({ string: `${host}:${port}` }),

    // 先把 dynamic table 塞滿
    encodeIntegerRFC7541({ prefix: "01", integer: 0 }),
    encodeStringLiteralsRFC7541({ string: "key" }),
    encodeStringLiteralsRFC7541({ huffman: true, string: "val01" }),

    encodeIntegerRFC7541({ prefix: "01", integer: 0 }),
    encodeStringLiteralsRFC7541({ string: "key" }),
    encodeStringLiteralsRFC7541({ huffman: true, string: "val02" }),

    // 引用看看，確認真的有塞到
    encodeIntegerRFC7541({ prefix: "1", integer: 62 }),
    encodeIntegerRFC7541({ prefix: "1", integer: 63 }),
  ]),
});
await writeAsync(socket, headersFrame1);
// 正常情境，假設 server 會正常回應 END_STREAM
// 就不特別檢查 HEADERS, DATA frame 的內容
const http2FramesReceivedAfterHeadersFrame1 = await readHttp2FramesUntil({
  socket,
  predicate: (http2Frame) => readUntilEndStream({ http2Frame, streamID: 1 }),
});
console.log(http2FramesReceivedAfterHeadersFrame1);
const headersFrame3 = getHeadersFrame({
  streamID: 3,
  flags: 5,
  fieldBlockFragment: Buffer.concat([
    encodeIntegerRFC7541({ prefix: "001", integer: 45 }),
    encodeIntegerRFC7541({ prefix: "001", integer: 40 }),
    encodeIntegerRFC7541({ prefix: "001", integer: 80 }),

    encodeIntegerRFC7541({ prefix: "1", integer: 2 }),
    encodeIntegerRFC7541({ prefix: "1", integer: 4 }),
    encodeIntegerRFC7541({ prefix: "1", integer: 6 }),
    encodeIntegerRFC7541({ prefix: "0001", integer: 1 }),
    encodeStringLiteralsRFC7541({ string: `${host}:${port}` }),

    // 引用看看，確認真的有塞到
    encodeIntegerRFC7541({ prefix: "1", integer: 62 }),
    encodeIntegerRFC7541({ prefix: "1", integer: 62 }),
  ]),
});
await writeAsync(socket, headersFrame3);
const http2FramesReceivedAfterHeadersFrame3 = await readHttp2FramesUntil({
  socket,
  predicate: (http2Frame) => readUntilEndStream({ http2Frame, streamID: 3 }),
});
console.log(http2FramesReceivedAfterHeadersFrame3);
console.log(`${fileName}: ok`);
process.exit(0);
