import http2 from "http2";
import net from "net";
import { serverOption } from "../server-option.js";
import {
  encodeIntegerRFC7541,
  encodeStringLiteralsRFC7541,
  getGoawayFrame,
  getHeadersFrame,
  http2ConnectionPreface,
  ERROR_CODES,
} from "../utils.js";
import { onceData } from "../utils.js";
import assert from "assert";
import { getFileName } from "../utils.js";

const fileName = getFileName(import.meta.filename);

const config = {
  sourceCode: [
    {
      repo: "https://github.com/nghttp2/nghttp2",
      code: `#define NGHTTP2_DEFAULT_MAX_CONTINUATIONS 8`,
    },
    {
      repo: "https://github.com/nghttp2/nghttp2",
      code: `
        if (++session->num_continuations > session->max_continuations) {
          return NGHTTP2_ERR_TOO_MANY_CONTINUATIONS;
        }
      `,
    },
  ],
};

const http2Server = http2.createServer();
http2Server.listen(serverOption.port);
http2Server.on("request", (req, res) => {
  console.log(req.headers);
});

const socket = net.connect({
  host: serverOption.host,
  port: serverOption.port,
  allowHalfOpen: false,
});
await http2ConnectionPreface(socket);
socket.on("error", console.log);
const fieldBlockFragment = Buffer.concat([
  encodeIntegerRFC7541({ prefix: "1", integer: 2 }),
  encodeIntegerRFC7541({ prefix: "1", integer: 4 }),
  encodeIntegerRFC7541({ prefix: "1", integer: 6 }),

  encodeIntegerRFC7541({ prefix: "0001", integer: 1 }),
  encodeStringLiteralsRFC7541({ string: `localhost:${serverOption.port}` }),
]);
let index = 0;
for (const byte of fieldBlockFragment) {
  const isLastByte = index === fieldBlockFragment.byteLength - 1;
  const isContinuationFrame = index !== 0;
  const headersFrame = getHeadersFrame({
    streamID: 1,
    flags: (() => {
      if (isLastByte) {
        if (isContinuationFrame) return 4;
        return 5;
      }
      if (isContinuationFrame) return 0;
      return 1;
    })(),
    isContinuationFrame,
    fieldBlockFragment: Buffer.from([byte]),
  });
  if (socket.writable) socket.write(headersFrame);
  else console.log("not writable");
  index++;
}
// 確保不符合規範的 server 可以正確被偵測
socket.setTimeout(5000, () => {
  console.log(`${fileName}: server does not close the TCP connection`);
  process.exit(1);
});
const maybeGoawayFrame = await onceData(socket);
const goawayFrame = getGoawayFrame({
  lastStreamID: 1,
  errorCode: ERROR_CODES.INTERNAL_ERROR,
});
assert(maybeGoawayFrame.equals(goawayFrame));
socket.on("close", () => {
  console.log(`${fileName}: ok`);
  process.exit(0);
});
