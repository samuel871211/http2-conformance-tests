import http2 from "http2";
import net from "net";
import {
  getHeadersFrame,
  http2ConnectionPreface,
  getGoawayFrame,
  ERROR_CODES,
} from "../utils.js";
import { onceData, writeAsync } from "../utils.js";
import { serverOption } from "../server-option.js";
import assert from "assert";
import { getFileName } from "../utils.js";

const fileName = getFileName(import.meta.filename);
const { host, port, enableNodejsHttp2Server } = serverOption;

const config = {
  rfc: [
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-4.3",
      description: `
        Each field block is processed as a discrete unit. Field blocks MUST
        be transmitted as a contiguous sequence of frames, with no
        interleaved frames of any other type or from any other stream.
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
const headersFrame1 = getHeadersFrame({
  streamID: 1,
  flags: 0,
  fieldBlockFragment: Buffer.alloc(0),
});
await writeAsync(socket, headersFrame1);
const headersFrame2 = getHeadersFrame({
  streamID: 3,
  flags: 0,
  fieldBlockFragment: Buffer.alloc(0),
});
await writeAsync(socket, headersFrame2);
// 確保不符合規範的 server 可以正確被偵測
socket.setTimeout(5000, () => {
  console.log(`${fileName}: server does not close the TCP connection`);
  process.exit(1);
});
const maybeGoawayFrame = await onceData(socket);
const goawayFrameNghttp2 = getGoawayFrame({
  lastStreamID: 1,
  errorCode: ERROR_CODES.PROTOCOL_ERROR,
  additionalDebugData: Buffer.from(
    "unexpected non-CONTINUATION frame or stream_id is invalid",
  ),
});
const goawayFrame2 = getGoawayFrame({
  lastStreamID: 1,
  errorCode: ERROR_CODES.PROTOCOL_ERROR,
});
assert(
  maybeGoawayFrame.equals(goawayFrameNghttp2) ||
    maybeGoawayFrame.equals(goawayFrame2),
);
socket.on("close", () => {
  console.log(`${fileName}: ok`);
  process.exit(0);
});
