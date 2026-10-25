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
  getFileName,
} from "../utils.js";

const fileName = getFileName(import.meta.filename);
const { host, port, enableNodejsHttp2Server } = serverOption;

const config = {
  rfc: [
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-6.3",
      description: `
        If a PRIORITY frame is received with a stream identifier of 0x00, the
        recipient MUST respond with a connection error (Section 5.4.1) of type
        PROTOCOL_ERROR.
      `,
    },
  ],
  sourceCode: [
    {
      // v1.70.0（Node.js v24.22.1 內建的版本），lib/nghttp2_session.c
      // 讀取 frame header 時，只檢查長度，沒有檢查 stream_id == 0
      repo: "https://github.com/nghttp2/nghttp2",
      code: `
        case NGHTTP2_PRIORITY:
          iframe->frame.hd.flags = NGHTTP2_FLAG_NONE;

          if (iframe->payloadleft != NGHTTP2_PRIORITY_SPECLEN) {
            busy = 1;
            iframe->state = NGHTTP2_IB_FRAME_SIZE_ERROR;
            break;
          }

          /* This is deprecated RFC 7540 priorities mechanism which is
             very unpopular.  We do not expect it is received so
             frequently. */
          rv = session_update_glitch_ratelim(session);
      `,
    },
    {
      // v1.70.0，lib/nghttp2_session.c
      // 讀完 payload 後直接丟棄，不呼叫任何處理函式，也不觸發 on_frame_recv_callback
      repo: "https://github.com/nghttp2/nghttp2",
      code: `
        case NGHTTP2_PRIORITY:
          session_inbound_frame_reset(session);

          break;
      `,
    },
    {
      // commit 3dd61f8ec "Remove RFC 7540 priorities"（v1.64.0 之後、v1.65.0 起生效）
      // 被刪除的 nghttp2_session_on_priority_received，原本會檢查 stream_id == 0
      repo: "https://github.com/nghttp2/nghttp2",
      code: `
        -int nghttp2_session_on_priority_received(nghttp2_session *session,
        -                                         nghttp2_frame *frame) {
        -  ...
        -  if (frame->hd.stream_id == 0) {
        -    return session_handle_invalid_connection(session, frame, NGHTTP2_ERR_PROTO,
        -                                             "PRIORITY: stream_id == 0");
        -  }
      `,
    },
    {
      // src/node_http2.cc（v24.x 分支）Http2Session::HandlePriorityFrame
      // 這個假設在 nghttp2 v1.65.0 之後已不成立
      repo: "https://github.com/nodejs/node",
      code: `
        // Priority frame stream ID should never be <= 0. nghttp2 handles this for us
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
const invalidPriorityFrame = Buffer.from([
  0x00, 0x00, 0x05,       // Length
  0x02,                   // Type
  0x00,                   // Flags
  0x00, 0x00, 0x00, 0x00, // Reserved + Stream Identifier (0)
  0x00, 0x00, 0x00, 0x00, // Exclusive + Stream Dependency
  0x0f,                   // Weight
]);
await writeAsync(socket, invalidPriorityFrame);
// 確保不符合規範的 server 可以正確被偵測
socket.setTimeout(5000, () => {
  console.log(`${fileName}: server does not close the TCP connection`);
  process.exit(1);
});
const maybeGoawayFrame = await readHttp2Frame(socket);
const goawayFrame = getGoawayFrame({
  lastStreamID: 0,
  errorCode: ERROR_CODES.PROTOCOL_ERROR,
});
assert(maybeGoawayFrame.raw.equals(goawayFrame));
socket.on("close", () => {
  console.log(`${fileName}: ok`);
  process.exit(0);
});
