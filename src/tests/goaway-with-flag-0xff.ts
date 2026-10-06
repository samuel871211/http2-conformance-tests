import { http2ConnectionPreface } from "../utils.js";
import http2, { type ServerHttp2Session } from "http2";
import net from "net";
import { serverOption } from "../server-option.js";
import { getFileName } from "../utils.js";

const fileName = getFileName(import.meta.filename);

const config = {
  rfc: [
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-4.1",
      description: `
        Unused flags MUST be ignored on receipt and MUST be left unset
        (0x00) when sending.
      `,
    },
  ],
};

const http2Server = http2.createServer();
http2Server.on("session", (serverHttp2Session) => {
  serverHttp2Session.on(
    "goaway",
    (errorCode: number, lastStreamID: number, opaqueData?: Buffer) => {
      console.log({ errorCode, lastStreamID, opaqueData });
      // { errorCode: 0, lastStreamID: 0, opaqueData: undefined }
      console.log(`${fileName}: ok`);
      process.exit(0);
    },
  );
});
http2Server.on("sessionError", (err: Error, session: ServerHttp2Session) => {
  // no trigger
  console.log(err);
  console.log(session);
});
http2Server.listen(serverOption.port);
// prettier-ignore
const goawayFrame = Buffer.from([
  0x00, 0x00, 0x08,       // Length
  0x07,                   // Type
  0xFF,                   // Flags
  0x00, 0x00, 0x00, 0x00, // Reserved + Stream Identifier
  0x00, 0x00, 0x00, 0x00, // Reserved + Last-Stream-ID
  0x00, 0x00, 0x00, 0x00, // Error Code
]);
const socket = net.connect({
  host: serverOption.host,
  port: serverOption.port,
});
await http2ConnectionPreface(socket);
socket.write(goawayFrame);
