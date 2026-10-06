import {
  ERROR_CODES,
  getGoawayFrame,
  http2ConnectionPreface,
} from "../utils.js";
import http2, { type ServerHttp2Session } from "http2";
import net from "net";
import { serverOption } from "../server-option.js";
import { getFileName } from "../utils.js";

const fileName = getFileName(import.meta.filename);

const config = {
  rfc: [
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-6.8",
      description: `
        The last stream identifier in the GOAWAY frame contains the
        highest-numbered stream identifier for which the sender of the GOAWAY
        frame might have taken some action on or might yet take action on.
      `,
    },
  ],
};

const http2Server = http2.createServer();
http2Server.on("session", (serverHttp2Session) => {
  // no trigger
  serverHttp2Session.on("goaway", console.log);
});
http2Server.on("sessionError", (err: Error, session: ServerHttp2Session) => {
  console.log(err);
  // Error [ERR_HTTP2_ERROR]: Protocol error
  //     at Http2Session.onSessionInternalError (node:internal/http2/core:868:26) {
  //   code: 'ERR_HTTP2_ERROR',
  //   errno: -505
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
  console.log(`${fileName}: ok`);
  process.exit(0);
});
http2Server.listen(serverOption.port);
const goawayFrame = getGoawayFrame({
  lastStreamID: 1,
  errorCode: ERROR_CODES.NO_ERROR,
});
const socket = net.connect({
  host: serverOption.host,
  port: serverOption.port,
});
await http2ConnectionPreface(socket);
socket.write(goawayFrame);
