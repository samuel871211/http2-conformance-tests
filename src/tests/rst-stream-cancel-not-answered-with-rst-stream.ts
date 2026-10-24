import http2 from "http2";
import net from "net";
import {
  encodeIntegerRFC7541,
  encodeStringLiteralsRFC7541,
  getHeadersFrame,
  getRSTFrame,
  http2ConnectionPreface,
  readHttp2FramesUntil,
  writeAsync,
  ERROR_CODES,
  getFileName,
  Http2FrameTypes,
} from "../utils.js";
import { serverOption } from "../server-option.js";

const fileName = getFileName(import.meta.filename);
const { host, port, enableNodejsHttp2Server } = serverOption;

const config = {
  rfc: [
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-5.4.2",
      description: `
        To avoid looping, an endpoint MUST NOT send a RST_STREAM in response
        to a RST_STREAM frame.
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
// 不帶 END_STREAM，讓 stream 1 保持 open
const headersFrame = getHeadersFrame({
  streamID: 1,
  flags: 4,
  fieldBlockFragment: Buffer.concat([
    encodeIntegerRFC7541({ prefix: "1", integer: 2 }),
    encodeIntegerRFC7541({ prefix: "1", integer: 4 }),
    encodeIntegerRFC7541({ prefix: "1", integer: 6 }),

    encodeIntegerRFC7541({ prefix: "0001", integer: 1 }),
    encodeStringLiteralsRFC7541({ string: `${host}:${port}` }),
  ]),
});
const rstFrame = getRSTFrame({
  streamID: 1,
  errorCode: ERROR_CODES.CANCEL,
});
await writeAsync(socket, Buffer.concat([headersFrame, rstFrame]));
// 3 秒內沒有收到 RST_STREAM 就視為通過
socket.setTimeout(3000, () => {
  console.log(`${fileName}: ok`);
  process.exit(0);
});
await readHttp2FramesUntil({
  socket,
  predicate: (http2Frame) => http2Frame.type === Http2FrameTypes.RST_STREAM,
});
console.log(`${fileName}: server sends RST_STREAM in response to RST_STREAM`);
process.exit(1);
