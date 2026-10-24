import http2 from "http2";
import net from "net";
import assert from "assert";
import { serverOption } from "../server-option.js";
import {
  http2ConnectionPreface,
  readHttp2Frame,
  writeAsync,
  ERROR_CODES,
  getGoawayFrame,
  getRSTFrame,
  getFileName,
  pingFrame,
  Http2FrameTypes,
} from "../utils.js";

const fileName = getFileName(import.meta.filename);
const { host, port, enableNodejsHttp2Server } = serverOption;

const config = {
  rfc: [
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-6.3",
      description: `
        A PRIORITY frame with a length other than 5 octets MUST be treated as
        a stream error (Section 5.4.2) of type FRAME_SIZE_ERROR.
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
}

const socket = net.connect({
  host,
  port,
  allowHalfOpen: false,
});
await http2ConnectionPreface(socket);
// PRIORITY frame 需要 5 bytes（Exclusive + Stream Dependency + Weight），這裡只給 4 bytes
// prettier-ignore
const invalidPriorityFrame = Buffer.from([
  0x00, 0x00, 0x04,       // Length
  0x02,                   // Type
  0x00,                   // Flags
  0x00, 0x00, 0x00, 0x01, // Reserved + Stream Identifier
  0x00, 0x00, 0x00, 0x00, // Exclusive + Stream Dependency (Weight is missing)
]);
await writeAsync(socket, invalidPriorityFrame);
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
    errorCode: ERROR_CODES.FRAME_SIZE_ERROR,
  });
  assert(maybeErrorFrame.raw.equals(rstFrame));
  // 用 PING 確認 connection 仍可使用
  await writeAsync(socket, pingFrame);
  const maybePingAckFrame = await readHttp2Frame(socket);
  assert(maybePingAckFrame.type === Http2FrameTypes.PING);
  assert(maybePingAckFrame.flags === 0x01);
  assert(maybePingAckFrame.payload.equals(pingFrame.subarray(9)));
  console.log(`${fileName}: ok`);
  process.exit(0);
} else {
  // connection error，server 關閉 TCP connection
  const goawayFrame = getGoawayFrame({
    lastStreamID: 0,
    errorCode: ERROR_CODES.FRAME_SIZE_ERROR,
  });
  assert(maybeErrorFrame.raw.equals(goawayFrame));
  socket.on("close", () => {
    console.log(`${fileName}: ok`);
    process.exit(0);
  });
}
