import http2, { type ServerHttp2Session } from "http2";
import { serverOption } from "../server-option.js";
import { getFileName } from "../utils.js";

const fileName = getFileName(import.meta.filename);

const config = {
  sourceCode: [
    {
      repo: "https://github.com/nghttp2/nghttp2",
      code: "NGHTTP2_DEFAULT_MAX_OBQ_FLOOD_ITEM",
    },
  ],
};

const http2Server = http2.createServer();
http2Server.listen(serverOption.port);
http2Server.on("sessionError", (err: Error, session: ServerHttp2Session) => {
  console.log(err);
  // Error [ERR_HTTP2_ERROR]: Flooding was detected in this HTTP/2 session, and it must be closed
  //     at Http2Session.onSessionInternalError (node:internal/http2/core:874:26) {
  //   code: 'ERR_HTTP2_ERROR',
  //   errno: -904
  // }
  console.log(session);
  // Http2Session {
  //   type: 0,
  //   closed: false,
  //   destroyed: true,
  //   state: {},
  //   localSettings: {},
  //   remoteSettings: {}
  // }
});

const clientHttp2Session = http2.connect(
  `http://${serverOption.host}:${serverOption.port}`,
  { maxOutstandingPings: Number.MAX_SAFE_INTEGER },
);
clientHttp2Session.on("error", console.log);
// Error [ERR_HTTP2_SESSION_ERROR]: Session closed with error code 2
//     at Http2Session.onGoawayData (node:internal/http2/core:760:21) {
//   code: 'ERR_HTTP2_SESSION_ERROR'
// }
// P.S. server send "GOAWAY" with Error Code "INTERNAL_ERROR"
// 需等到 `on("connect")` 之後才能正確送出 PING frame
await new Promise((resolve) => clientHttp2Session.on("connect", resolve));
const payload = Buffer.from("12345678", "latin1");
const count = 1000;
const array = Array(count).fill(0);
const result = { success: 0, error: 0 };
array.forEach(() =>
  clientHttp2Session.ping(payload, (err) => {
    if (err) result.error += 1;
    else result.success += 1;
    if (result.error + result.success === count) {
      console.log(result);
      // { success: 0, error: 1000 }
      console.log(`${fileName}: ok`);
      process.exit(0);
    }
  }),
);
