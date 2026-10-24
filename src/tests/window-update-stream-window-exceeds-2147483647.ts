import http2 from "http2";
import net from "net";
import assert from "assert";
import { serverOption } from "../server-option.js";
import {
  encodeIntegerRFC7541,
  encodeStringLiteralsRFC7541,
  getGoawayFrame,
  getHeadersFrame,
  getRSTFrame,
  getWindowUpdateFrame,
  http2ConnectionPreface,
  readHttp2Frame,
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
        A sender MUST NOT allow a flow-control window to exceed 2^31-1
        octets.  If a sender receives a WINDOW_UPDATE that causes a
        flow-control window to exceed this maximum, it MUST terminate either
        the stream or the connection, as appropriate.  For streams, the
        sender sends a RST_STREAM with an error code of FLOW_CONTROL_ERROR;
        for the connection, a GOAWAY frame with an error code of
        FLOW_CONTROL_ERROR is sent.
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
// 不帶 END_STREAM 和 response，讓 stream 1 保持 open
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
// stream window 初始值 65535，加上 2^31 - 1 會超過上限
const windowUpdateFrame = getWindowUpdateFrame({
  streamID: 1,
  windowSizeIncrement: 2 ** 31 - 1,
});
await writeAsync(socket, Buffer.concat([headersFrame, windowUpdateFrame]));
// 確保不符合規範的 server 可以正確被偵測
socket.setTimeout(5000, () => {
  console.log(`${fileName}: server does not respond with RST_STREAM or GOAWAY`);
  process.exit(1);
});
const maybeErrorFrame = await readHttp2Frame(socket);
if (maybeErrorFrame.type === Http2FrameTypes.RST_STREAM) {
  // stream error，connection 維持開啟
  const rstFrame = getRSTFrame({
    streamID: 1,
    errorCode: ERROR_CODES.FLOW_CONTROL_ERROR,
  });
  assert(maybeErrorFrame.raw.equals(rstFrame));
  console.log(`${fileName}: ok`);
  process.exit(0);
} else {
  // connection error，server 關閉 TCP connection
  const goawayFrame = getGoawayFrame({
    lastStreamID: 1,
    errorCode: ERROR_CODES.FLOW_CONTROL_ERROR,
  });
  const goawayFrameNghttp2 = getGoawayFrame({
    lastStreamID: 1,
    errorCode: ERROR_CODES.FLOW_CONTROL_ERROR,
    additionalDebugData: Buffer.from(
      "WINDOW_UPDATE: window size overflow",
      "utf8",
    ),
  });
  assert(
    maybeErrorFrame.raw.equals(goawayFrame) ||
      maybeErrorFrame.raw.equals(goawayFrameNghttp2),
  );
  socket.on("close", () => {
    console.log(`${fileName}: ok`);
    process.exit(0);
  });
}
