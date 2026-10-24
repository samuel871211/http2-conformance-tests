import http2 from "http2";
import net from "net";
import assert from "assert";
import { serverOption } from "../server-option.js";
import {
  encodeIntegerRFC7541,
  encodeStringLiteralsRFC7541,
  getHeadersFrame,
  getDataFrame,
  getGoawayFrame,
  getRSTFrame,
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
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-6.9.1",
      description: `
        The sender MUST NOT send a flow-controlled frame with a length that
        exceeds the space available in either of the flow-control windows
        advertised by the receiver.
      `,
    },
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-7",
      description: `
        FLOW_CONTROL_ERROR (0x03): The endpoint detected that its peer
        violated the flow-control protocol.
      `,
    },
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-5.4.2",
      description: `
        An endpoint MAY choose to treat a stream error as a connection error.
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
// 前 4 個 DATA 剛好用完預設 initial window size (65535)：3 x 16384 + 16383
// 最後 1 個 DATA 多 1 byte，總共 65536 bytes
const dataFrames = [
  getDataFrame({ streamID: 1, flags: 0, data: Buffer.alloc(16384) }),
  getDataFrame({ streamID: 1, flags: 0, data: Buffer.alloc(16384) }),
  getDataFrame({ streamID: 1, flags: 0, data: Buffer.alloc(16384) }),
  getDataFrame({ streamID: 1, flags: 0, data: Buffer.alloc(16383) }),
  getDataFrame({ streamID: 1, flags: 0, data: Buffer.alloc(1) }),
];
await writeAsync(socket, Buffer.concat([headersFrame].concat(dataFrames)));
// 確保不符合規範的 server 可以正確被偵測
socket.setTimeout(5000, () => {
  console.log(`${fileName}: server does not respond with RST_STREAM or GOAWAY`);
  process.exit(1);
});
const http2Frames = await readHttp2FramesUntil({
  socket,
  predicate: (http2Frame) =>
    http2Frame.type === Http2FrameTypes.RST_STREAM ||
    http2Frame.type === Http2FrameTypes.GOAWAY,
});
const lastHttp2Frame = http2Frames[http2Frames.length - 1]!;
if (lastHttp2Frame.type === Http2FrameTypes.RST_STREAM) {
  // stream error，connection 維持開啟
  const rstFrame = getRSTFrame({
    streamID: 1,
    errorCode: ERROR_CODES.FLOW_CONTROL_ERROR,
  });
  assert(lastHttp2Frame.raw.equals(rstFrame));
  console.log(`${fileName}: ok`);
  process.exit(0);
} else {
  // connection error，server 關閉 TCP connection
  const goawayFrame = getGoawayFrame({
    lastStreamID: 1,
    errorCode: ERROR_CODES.FLOW_CONTROL_ERROR,
  });
  assert(lastHttp2Frame.raw.equals(goawayFrame));
  socket.on("close", () => {
    console.log(`${fileName}: ok`);
    process.exit(0);
  });
}
