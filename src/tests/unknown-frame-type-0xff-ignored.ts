import http2 from "http2";
import net from "net";
import assert from "assert";
import { serverOption } from "../server-option.js";
import {
  http2ConnectionPreface,
  readHttp2FramesUntil,
  writeAsync,
  pingFrame,
  getFileName,
  Http2FrameTypes,
} from "../utils.js";

const fileName = getFileName(import.meta.filename);
const { host, port, enableNodejsHttp2Server } = serverOption;

const config = {
  rfc: [
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-4.1",
      description: `
        Type:  The 8-bit type of the frame.  The frame type determines the
        format and semantics of the frame.  Implementations MUST ignore and
        discard frames of unknown types.
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
// prettier-ignore
const unknownFrame = Buffer.from([
  0x00, 0x00, 0x04,       // Length
  0xff,                   // Type (unknown)
  0x00,                   // Flags
  0x00, 0x00, 0x00, 0x00, // Reserved + Stream Identifier
  0x01, 0x02, 0x03, 0x04, // Payload
]);
await writeAsync(socket, Buffer.concat([unknownFrame, pingFrame]));
// 確保不符合規範的 server 可以正確被偵測
socket.setTimeout(5000, () => {
  console.log(`${fileName}: server does not respond with PING ACK`);
  process.exit(1);
});
// unknown frame 被忽略後，server 應該只回 PING ACK，不應該有 GOAWAY
const http2Frames = await readHttp2FramesUntil({
  socket,
  predicate: (http2Frame) =>
    http2Frame.type === Http2FrameTypes.PING ||
    http2Frame.type === Http2FrameTypes.GOAWAY,
});
const maybePingAckFrame = http2Frames[http2Frames.length - 1]!;
assert(maybePingAckFrame.type === Http2FrameTypes.PING);
assert(maybePingAckFrame.flags === 0x01);
assert(maybePingAckFrame.streamID === 0);
assert(maybePingAckFrame.payload.equals(pingFrame.subarray(9)));
console.log(`${fileName}: ok`);
process.exit(0);
