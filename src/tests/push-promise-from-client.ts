import http2 from "http2";
import net from "net";
import assert from "assert";
import { serverOption } from "../server-option.js";
import {
  encodeIntegerRFC7541,
  encodeStringLiteralsRFC7541,
  getHeadersFrame,
  getPushPromiseFrame,
  http2ConnectionPreface,
  readHttp2FramesUntil,
  writeAsync,
  ERROR_CODES,
  getGoawayFrame,
  getFileName,
  Http2FrameTypes,
  getSettingsFrame,
} from "../utils.js";

const fileName = getFileName(import.meta.filename);
const { host, port, enableNodejsHttp2Server } = serverOption;

const config = {
  rfc: [
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-8.4",
      description: `
        A client cannot push.  Thus, servers MUST treat the receipt of a
        PUSH_PROMISE frame as a connection error (Section 5.4.1) of type
        PROTOCOL_ERROR.
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
const settingFrame = getSettingsFrame({ SETTINGS_ENABLE_PUSH: 1 });
await http2ConnectionPreface(socket, settingFrame);
const fieldBlockFragment = Buffer.concat([
  encodeIntegerRFC7541({ prefix: "1", integer: 2 }),
  encodeIntegerRFC7541({ prefix: "1", integer: 4 }),
  encodeIntegerRFC7541({ prefix: "1", integer: 6 }),

  encodeIntegerRFC7541({ prefix: "0001", integer: 1 }),
  encodeStringLiteralsRFC7541({ string: `${host}:${port}` }),
]);
// 不帶 END_STREAM，讓 stream 1 保持 open
const headersFrame = getHeadersFrame({
  streamID: 1,
  flags: 4,
  fieldBlockFragment,
});
// frame 格式合法，但 client 不能送 PUSH_PROMISE
const pushPromiseFrame = getPushPromiseFrame({
  streamID: 1,
  flags: 4,
  promisedStreamID: 2,
  fieldBlockFragment,
});
await writeAsync(socket, Buffer.concat([headersFrame, pushPromiseFrame]));
// 確保不符合規範的 server 可以正確被偵測
socket.setTimeout(5000, () => {
  console.log(`${fileName}: server does not close the TCP connection`);
  process.exit(1);
});
const http2Frames = await readHttp2FramesUntil({
  socket,
  predicate: (http2Frame) => http2Frame.type === Http2FrameTypes.GOAWAY,
});
const maybeGoawayFrame = http2Frames[http2Frames.length - 1]!;
const goawayFrame = getGoawayFrame({
  lastStreamID: 1,
  errorCode: ERROR_CODES.PROTOCOL_ERROR,
});
const goawayFrameNghttp2 = getGoawayFrame({
  lastStreamID: 1,
  errorCode: ERROR_CODES.PROTOCOL_ERROR,
  additionalDebugData: Buffer.from("PUSH_PROMISE: push disabled", "utf8"),
});
assert(
  maybeGoawayFrame.raw.equals(goawayFrame) ||
    maybeGoawayFrame.raw.equals(goawayFrameNghttp2),
);
socket.on("close", () => {
  console.log(`${fileName}: ok`);
  process.exit(0);
});
