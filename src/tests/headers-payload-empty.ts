import http2 from "http2";
import net from "net";
import { getHeadersFrame, http2ConnectionPreface } from "../utils.js";
import { getFileName } from "../utils.js";
import { serverOption } from "../server-option.js";

const fileName = getFileName(import.meta.filename);
const { host, port } = serverOption;

const config = {
  rfc: [
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-6.2",
      description: `
        A HEADERS frame without the END_HEADERS flag set MUST be followed by
        a CONTINUATION frame for the same stream.
      `,
    },
  ],
};

const http2Server = http2.createServer();
http2Server.listen(port);

const socket = net.connect({
  host,
  port,
  allowHalfOpen: false,
});
await http2ConnectionPreface(socket);
const headersFrame = getHeadersFrame({
  streamID: 1,
  flags: 0,
  fieldBlockFragment: Buffer.alloc(0),
});
socket.write(headersFrame);
socket.setTimeout(5000, () => {
  console.log(`${fileName}: ok`);
  process.exit(0);
});
