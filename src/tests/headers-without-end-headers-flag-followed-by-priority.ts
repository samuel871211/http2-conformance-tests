import http2 from "http2";
import net from "net";
import assert from "assert";
import { serverOption } from "../server-option.js";
import {
  getHeadersFrame,
  getPriorityFrame,
  http2ConnectionPreface,
  readHttp2Frame,
  writeAsync,
  ERROR_CODES,
  getGoawayFrame,
  getFileName,
} from "../utils.js";

const fileName = getFileName(import.meta.filename);
const { host, port, enableNodejsHttp2Server } = serverOption;

const config = {
  rfc: [
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-6.3",
      description: `
        A PRIORITY frame cannot be sent between consecutive frames that
        comprise a single field block (Section 4.3).
      `,
    },
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-6.2",
      description: `
        A HEADERS frame without the END_HEADERS flag set MUST be followed by a
        CONTINUATION frame for the same stream.  A receiver MUST treat the
        receipt of any other type of frame or a frame on a different stream as
        a connection error (Section 5.4.1) of type PROTOCOL_ERROR.
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
const headersFrame = getHeadersFrame({
  streamID: 1,
  flags: 0,
  fieldBlockFragment: Buffer.alloc(0),
});
const priorityFrame = getPriorityFrame({
  streamID: 1,
  exclusive: 0,
  streamDependency: 0,
  weight: 15,
});
await writeAsync(socket, Buffer.concat([headersFrame, priorityFrame]));
// 確保不符合規範的 server 可以正確被偵測
socket.setTimeout(5000, () => {
  console.log(`${fileName}: server does not close the TCP connection`);
  process.exit(1);
});
const maybeGoawayFrame = await readHttp2Frame(socket);
const goawayFrameNghttp2 = getGoawayFrame({
  lastStreamID: 1,
  errorCode: ERROR_CODES.PROTOCOL_ERROR,
  additionalDebugData: Buffer.from(
    "unexpected non-CONTINUATION frame or stream_id is invalid",
  ),
});
const goawayFrame = getGoawayFrame({
  lastStreamID: 1,
  errorCode: ERROR_CODES.PROTOCOL_ERROR,
});
assert(
  maybeGoawayFrame.raw.equals(goawayFrameNghttp2) ||
    maybeGoawayFrame.raw.equals(goawayFrame),
);
socket.on("close", () => {
  console.log(`${fileName}: ok`);
  process.exit(0);
});
