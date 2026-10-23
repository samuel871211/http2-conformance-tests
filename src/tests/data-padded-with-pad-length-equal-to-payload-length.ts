import http2 from "http2";
import net from "net";
import assert from "assert";
import { serverOption } from "../server-option.js";
import {
  encodeIntegerRFC7541,
  encodeStringLiteralsRFC7541,
  getHeadersFrame,
  http2ConnectionPreface,
  writeAsync,
  ERROR_CODES,
  getFileName,
  readHttp2Frame,
  getGoawayFrame,
} from "../utils.js";

const fileName = getFileName(import.meta.filename);
const { host, port, enableNodejsHttp2Server } = serverOption;

const config = {
  rfc: [
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-6.1",
      description: `
        If the length of the padding is the length of the frame payload or
        greater, the recipient MUST treat this as a connection error
        (Section 5.4.1) of type PROTOCOL_ERROR.
      `,
    },
  ],
};

if (enableNodejsHttp2Server) {
  const http2Server = http2.createServer();
  http2Server.listen(port);
  http2Server.on("stream", (stream) => stream.on("error", () => {}));
}

const socket = net.connect({
  host,
  port,
  allowHalfOpen: false,
});
await http2ConnectionPreface(socket);
// END_HEADERS，stream 1 保持 open
const headersFrame = getHeadersFrame({
  streamID: 1,
  flags: 4,
  fieldBlockFragment: Buffer.concat([
    encodeIntegerRFC7541({ prefix: "1", integer: 3 }),
    encodeIntegerRFC7541({ prefix: "1", integer: 4 }),
    encodeIntegerRFC7541({ prefix: "1", integer: 6 }),

    encodeIntegerRFC7541({ prefix: "0001", integer: 1 }),
    encodeStringLiteralsRFC7541({ string: `${host}:${port}` }),
  ]),
});
// prettier-ignore
const invalidDataFrame = Buffer.from([
  0x00, 0x00, 0x02,       // Length
  0x00,                   // Type
  0x08,                   // Flags (PADDED)
  0x00, 0x00, 0x00, 0x01, // Reserved + Stream Identifier
  0x02,                   // Pad Length (等於 Length)
  0x00,                   // Payload
]);
await writeAsync(socket, Buffer.concat([headersFrame, invalidDataFrame]));
// 確保不符合規範的 server 可以正確被偵測
socket.setTimeout(5000, () => {
  console.log(`${fileName}: server does not close the TCP connection`);
  process.exit(1);
});
const maybeGoawayFrame = await readHttp2Frame(socket);
const goawayFrameNghttp2 = getGoawayFrame({
  lastStreamID: 1,
  errorCode: ERROR_CODES.PROTOCOL_ERROR,
  additionalDebugData: Buffer.from("DATA: invalid padding", "latin1"),
});
assert(maybeGoawayFrame.raw.equals(goawayFrameNghttp2));
socket.on("close", () => {
  console.log(`${fileName}: ok`);
  process.exit(0);
});
