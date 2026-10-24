import http2 from "http2";
import net from "net";
import assert from "assert";
import { serverOption } from "../server-option.js";
import {
  encodeIntegerRFC7541,
  encodeStringLiteralsRFC7541,
  getGoawayFrame,
  getHeadersFrame,
  getSettingsFrame,
  getWindowUpdateFrame,
  http2ConnectionPreface,
  readHttp2FramesUntil,
  writeAsync,
  ERROR_CODES,
  getFileName,
  Http2FrameTypes,
} from "../utils.js";

const fileName = getFileName(import.meta.filename);
const { host, port, enableNodejsHttp2Server } = serverOption;

const config = {
  rfc: [
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-6.9.2",
      description: `
        An endpoint MUST treat a change to SETTINGS_INITIAL_WINDOW_SIZE that
        causes any flow-control window to exceed the maximum size as a
        connection error (Section 5.4.1) of type FLOW_CONTROL_ERROR.
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
// stream 1 的 send window：65535 + (2^31 - 1 - 65535) = 2^31 - 1，剛好是上限
const windowUpdateFrame = getWindowUpdateFrame({
  streamID: 1,
  windowSizeIncrement: 2 ** 31 - 1 - 65535,
});
// initial window size 從 65535 改成 65536，stream 1 的 send window 會多 1 byte，超過上限
const settingsFrame = getSettingsFrame({ SETTINGS_INITIAL_WINDOW_SIZE: 65536 });
await writeAsync(
  socket,
  Buffer.concat([headersFrame, windowUpdateFrame, settingsFrame]),
);
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
  errorCode: ERROR_CODES.FLOW_CONTROL_ERROR,
});
assert(maybeGoawayFrame.raw.equals(goawayFrame));
socket.on("close", () => {
  console.log(`${fileName}: ok`);
  process.exit(0);
});
