import { Socket } from "net";
import { Writable } from "stream";
import { TLSSocket } from "tls";
import type { Http2Session, Settings } from "http2";
import assert from "assert";

/**
 * https://datatracker.ietf.org/doc/html/rfc9113#name-error-codes
 */
const ERROR_CODES = {
  NO_ERROR: 0,
  PROTOCOL_ERROR: 1,
  INTERNAL_ERROR: 2,
  FLOW_CONTROL_ERROR: 3,
  SETTINGS_TIMEOUT: 4,
  STREAM_CLOSED: 5,
  FRAME_SIZE_ERROR: 6,
  REFUSED_STREAM: 7,
  CANCEL: 8,
  COMPRESSION_ERROR: 9,
  CONNECT_ERROR: 10,
  ENHANCE_YOUR_CALM: 11,
  INADEQUATE_SECURITY: 12,
  HTTP_1_1_REQUIRED: 13,
} as const;

const HPACK_STATIC_TABLE = [
  { name: undefined, value: undefined },
  { name: ":authority", value: undefined }, // 1
  { name: ":method", value: "GET" }, // 2
  { name: ":method", value: "POST" }, // 3
  { name: ":path", value: "/" }, // 4
  { name: ":path", value: "/index.html" }, // 5
  { name: ":scheme", value: "http" }, // 6
  { name: ":scheme", value: "https" }, // 7
  { name: ":status", value: "200" }, // 8
  { name: ":status", value: "204" }, // 9
  { name: ":status", value: "206" }, // 10
  { name: ":status", value: "304" }, // 11
  { name: ":status", value: "400" }, // 12
  { name: ":status", value: "404" }, // 13
  { name: ":status", value: "500" }, // 14
  { name: "accept-charset", value: undefined }, // 15
  { name: "accept-encoding", value: "gzip, deflate" }, // 16
  { name: "accept-language", value: undefined }, // 17
  { name: "accept-ranges", value: undefined }, // 18
  { name: "accept", value: undefined }, // 19
  { name: "access-control-allow-origin", value: undefined }, // 20
  { name: "age", value: undefined }, // 21
  { name: "allow", value: undefined }, // 22
  { name: "authorization", value: undefined }, // 23
  { name: "cache-control", value: undefined }, // 24
  { name: "content-disposition", value: undefined }, // 25
  { name: "content-encoding", value: undefined }, // 26
  { name: "content-language", value: undefined }, // 27
  { name: "content-length", value: undefined }, // 28
  { name: "content-location", value: undefined }, // 29
  { name: "content-range", value: undefined }, // 30
  { name: "content-type", value: undefined }, // 31
  { name: "cookie", value: undefined }, // 32
  { name: "date", value: undefined }, // 33
  { name: "etag", value: undefined }, // 34
  { name: "expect", value: undefined }, // 35
  { name: "expires", value: undefined }, // 36
  { name: "from", value: undefined }, // 37
  { name: "host", value: undefined }, // 38
  { name: "if-match", value: undefined }, // 39
  { name: "if-modified-since", value: undefined }, // 40
  { name: "if-none-match", value: undefined }, // 41
  { name: "if-range", value: undefined }, // 42
  { name: "if-unmodified-since", value: undefined }, // 43
  { name: "last-modified", value: undefined }, // 44
  { name: "link", value: undefined }, // 45
  { name: "location", value: undefined }, // 46
  { name: "max-forwards", value: undefined }, // 47
  { name: "proxy-authenticate", value: undefined }, // 48
  { name: "proxy-authorization", value: undefined }, // 49
  { name: "range", value: undefined }, // 50
  { name: "referer", value: undefined }, // 51
  { name: "refresh", value: undefined }, // 52
  { name: "retry-after", value: undefined }, // 53
  { name: "server", value: undefined }, // 54
  { name: "set-cookie", value: undefined }, // 55
  { name: "strict-transport-security", value: undefined }, // 56
  { name: "transfer-encoding", value: undefined }, // 57
  { name: "user-agent", value: undefined }, // 58
  { name: "vary", value: undefined }, // 59
  { name: "via", value: undefined }, // 60
  { name: "www-authenticate", value: undefined }, // 61
];

const HUFFMAN_CODE = [
  "1111111111000", // 0
  "11111111111111111011000", // 1
  "1111111111111111111111100010", // 2
  "1111111111111111111111100011", // 3
  "1111111111111111111111100100", // 4
  "1111111111111111111111100101", // 5
  "1111111111111111111111100110", // 6
  "1111111111111111111111100111", // 7
  "1111111111111111111111101000", // 8
  "111111111111111111101010", // 9
  "111111111111111111111111111100", // 10
  "1111111111111111111111101001", // 11
  "1111111111111111111111101010", // 12
  "111111111111111111111111111101", // 13
  "1111111111111111111111101011", // 14
  "1111111111111111111111101100", // 15
  "1111111111111111111111101101", // 16
  "1111111111111111111111101110", // 17
  "1111111111111111111111101111", // 18
  "1111111111111111111111110000", // 19
  "1111111111111111111111110001", // 20
  "1111111111111111111111110010", // 21
  "111111111111111111111111111110", // 22
  "1111111111111111111111110011", // 23
  "1111111111111111111111110100", // 24
  "1111111111111111111111110101", // 25
  "1111111111111111111111110110", // 26
  "1111111111111111111111110111", // 27
  "1111111111111111111111111000", // 28
  "1111111111111111111111111001", // 29
  "1111111111111111111111111010", // 30
  "1111111111111111111111111011", // 31
  "010100", // 32 ' '
  "1111111000", // 33 '!'
  "1111111001", // 34 '"'
  "111111111010", // 35 '#'
  "1111111111001", // 36 '$'
  "010101", // 37 '%'
  "11111000", // 38 '&'
  "11111111010", // 39 '''
  "1111111010", // 40 '('
  "1111111011", // 41 ')'
  "11111001", // 42 '*'
  "11111111011", // 43 '+'
  "11111010", // 44 ','
  "010110", // 45 '-'
  "010111", // 46 '.'
  "011000", // 47 '/'
  "00000", // 48 '0'
  "00001", // 49 '1'
  "00010", // 50 '2'
  "011001", // 51 '3'
  "011010", // 52 '4'
  "011011", // 53 '5'
  "011100", // 54 '6'
  "011101", // 55 '7'
  "011110", // 56 '8'
  "011111", // 57 '9'
  "1011100", // 58 ':'
  "11111011", // 59 ';'
  "111111111111100", // 60 '<'
  "100000", // 61 '='
  "111111111011", // 62 '>'
  "1111111100", // 63 '?'
  "1111111111010", // 64 '@'
  "100001", // 65 'A'
  "1011101", // 66 'B'
  "1011110", // 67 'C'
  "1011111", // 68 'D'
  "1100000", // 69 'E'
  "1100001", // 70 'F'
  "1100010", // 71 'G'
  "1100011", // 72 'H'
  "1100100", // 73 'I'
  "1100101", // 74 'J'
  "1100110", // 75 'K'
  "1100111", // 76 'L'
  "1101000", // 77 'M'
  "1101001", // 78 'N'
  "1101010", // 79 'O'
  "1101011", // 80 'P'
  "1101100", // 81 'Q'
  "1101101", // 82 'R'
  "1101110", // 83 'S'
  "1101111", // 84 'T'
  "1110000", // 85 'U'
  "1110001", // 86 'V'
  "1110010", // 87 'W'
  "11111100", // 88 'X'
  "1110011", // 89 'Y'
  "11111101", // 90 'Z'
  "1111111111011", // 91 '['
  "1111111111111110000", // 92 '\'
  "1111111111100", // 93 ']'
  "11111111111100", // 94 '^'
  "100010", // 95 '_'
  "111111111111101", // 96 '`'
  "00011", // 97 'a'
  "100011", // 98 'b'
  "00100", // 99 'c'
  "100100", // 100 'd'
  "00101", // 101 'e'
  "100101", // 102 'f'
  "100110", // 103 'g'
  "100111", // 104 'h'
  "00110", // 105 'i'
  "1110100", // 106 'j'
  "1110101", // 107 'k'
  "101000", // 108 'l'
  "101001", // 109 'm'
  "101010", // 110 'n'
  "00111", // 111 'o'
  "101011", // 112 'p'
  "1110110", // 113 'q'
  "101100", // 114 'r'
  "01000", // 115 's'
  "01001", // 116 't'
  "101101", // 117 'u'
  "1110111", // 118 'v'
  "1111000", // 119 'w'
  "1111001", // 120 'x'
  "1111010", // 121 'y'
  "1111011", // 122 'z'
  "111111111111110", // 123 '{'
  "11111111100", // 124 '|'
  "11111111111101", // 125 '}'
  "1111111111101", // 126 '~'
  "1111111111111111111111111100", // 127
  "11111111111111100110", // 128
  "1111111111111111010010", // 129
  "11111111111111100111", // 130
  "11111111111111101000", // 131
  "1111111111111111010011", // 132
  "1111111111111111010100", // 133
  "1111111111111111010101", // 134
  "11111111111111111011001", // 135
  "1111111111111111010110", // 136
  "11111111111111111011010", // 137
  "11111111111111111011011", // 138
  "11111111111111111011100", // 139
  "11111111111111111011101", // 140
  "11111111111111111011110", // 141
  "111111111111111111101011", // 142
  "11111111111111111011111", // 143
  "111111111111111111101100", // 144
  "111111111111111111101101", // 145
  "1111111111111111010111", // 146
  "11111111111111111100000", // 147
  "111111111111111111101110", // 148
  "11111111111111111100001", // 149
  "11111111111111111100010", // 150
  "11111111111111111100011", // 151
  "11111111111111111100100", // 152
  "111111111111111011100", // 153
  "1111111111111111011000", // 154
  "11111111111111111100101", // 155
  "1111111111111111011001", // 156
  "11111111111111111100110", // 157
  "11111111111111111100111", // 158
  "111111111111111111101111", // 159
  "1111111111111111011010", // 160
  "111111111111111011101", // 161
  "11111111111111101001", // 162
  "1111111111111111011011", // 163
  "1111111111111111011100", // 164
  "11111111111111111101000", // 165
  "11111111111111111101001", // 166
  "111111111111111011110", // 167
  "11111111111111111101010", // 168
  "1111111111111111011101", // 169
  "1111111111111111011110", // 170
  "111111111111111111110000", // 171
  "111111111111111011111", // 172
  "1111111111111111011111", // 173
  "11111111111111111101011", // 174
  "11111111111111111101100", // 175
  "111111111111111100000", // 176
  "111111111111111100001", // 177
  "1111111111111111100000", // 178
  "111111111111111100010", // 179
  "11111111111111111101101", // 180
  "1111111111111111100001", // 181
  "11111111111111111101110", // 182
  "11111111111111111101111", // 183
  "11111111111111101010", // 184
  "1111111111111111100010", // 185
  "1111111111111111100011", // 186
  "1111111111111111100100", // 187
  "11111111111111111110000", // 188
  "1111111111111111100101", // 189
  "1111111111111111100110", // 190
  "11111111111111111110001", // 191
  "11111111111111111111100000", // 192
  "11111111111111111111100001", // 193
  "11111111111111101011", // 194
  "1111111111111110001", // 195
  "1111111111111111100111", // 196
  "11111111111111111110010", // 197
  "1111111111111111101000", // 198
  "1111111111111111111101100", // 199
  "11111111111111111111100010", // 200
  "11111111111111111111100011", // 201
  "11111111111111111111100100", // 202
  "111111111111111111111011110", // 203
  "111111111111111111111011111", // 204
  "11111111111111111111100101", // 205
  "111111111111111111110001", // 206
  "1111111111111111111101101", // 207
  "1111111111111110010", // 208
  "111111111111111100011", // 209
  "11111111111111111111100110", // 210
  "111111111111111111111100000", // 211
  "111111111111111111111100001", // 212
  "11111111111111111111100111", // 213
  "111111111111111111111100010", // 214
  "111111111111111111110010", // 215
  "111111111111111100100", // 216
  "111111111111111100101", // 217
  "11111111111111111111101000", // 218
  "11111111111111111111101001", // 219
  "1111111111111111111111111101", // 220
  "111111111111111111111100011", // 221
  "111111111111111111111100100", // 222
  "111111111111111111111100101", // 223
  "11111111111111101100", // 224
  "111111111111111111110011", // 225
  "11111111111111101101", // 226
  "111111111111111100110", // 227
  "1111111111111111101001", // 228
  "111111111111111100111", // 229
  "111111111111111101000", // 230
  "11111111111111111110011", // 231
  "1111111111111111101010", // 232
  "1111111111111111101011", // 233
  "1111111111111111111101110", // 234
  "1111111111111111111101111", // 235
  "111111111111111111110100", // 236
  "111111111111111111110101", // 237
  "11111111111111111111101010", // 238
  "11111111111111111110100", // 239
  "11111111111111111111101011", // 240
  "111111111111111111111100110", // 241
  "11111111111111111111101100", // 242
  "11111111111111111111101101", // 243
  "111111111111111111111100111", // 244
  "111111111111111111111101000", // 245
  "111111111111111111111101001", // 246
  "111111111111111111111101010", // 247
  "111111111111111111111101011", // 248
  "1111111111111111111111111110", // 249
  "111111111111111111111101100", // 250
  "111111111111111111111101101", // 251
  "111111111111111111111101110", // 252
  "111111111111111111111101111", // 253
  "111111111111111111111110000", // 254
  "11111111111111111111101110", // 255
  "111111111111111111111111111111", // 256 EOS
];

const magic = Buffer.from("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n", "latin1");
// prettier-ignore
const emptySettingsFrame = Buffer.from([
  0x00, 0x00, 0x00,       // Length
  0x04,                   // Type
  0x00,                   // Flags
  0x00, 0x00, 0x00, 0x00, // Reserved + Stream Identifier
]);
// prettier-ignore
const pingFrame = Buffer.from([
  0x00, 0x00, 0x08,       // Length
  0x06,                   // Type
  0x00,                   // Flags
  0x00, 0x00, 0x00, 0x00, // Reserved + Stream Identifier
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, // Opaque Data
]);
// prettier-ignore
const settingsACKFrame = Buffer.from([
  0x00, 0x00, 0x00,       // Length
  0x04,                   // Type
  0x01,                   // Flags
  0x00, 0x00, 0x00, 0x00, // Reserved + Stream Identifier
]);

// function numberToNBytesBuffer(params: { num: number, n: number }) {
//   const { num, n } = params;
//   const result = Buffer.alloc(n);
//   result.writeUintBE(num, 0, n);
//   return result;
// }

function numberTo1ByteBuffer(num: number) {
  const result = Buffer.alloc(1);
  result.writeUintBE(num, 0, 1);
  return result;
}

function numberTo3BytesBuffer(byteLength: number) {
  const result = Buffer.alloc(3);
  result.writeUintBE(byteLength, 0, 3);
  return result;
}

function numberTo4BytesBuffer(num: number) {
  const result = Buffer.alloc(4);
  result.writeUintBE(num, 0, 4);
  return result;
}

/**
 * FIXME: 實作 readExactly
 */
function waitForSettingsFrameAndAckBack(socket: Socket) {
  return new Promise((resolve, reject) => {
    socket.once("readable", () => {
      const frameHeader: Buffer = socket.read(9);
      const payloadLength = frameHeader.readUintBE(0, 3);
      const framePayload = socket.read(payloadLength);
      if (frameHeader[3] === 0x04 && frameHeader[4] === 0x00) {
        socket.write(settingsACKFrame, () => resolve(true));
        return;
      }
      console.error(frameHeader, framePayload);
      reject("not SETTINGS frame");
    });
  });
}

/**
 * FIXME: 實作 readExactly
 */
function waitForSettingsACKFrame(socket: Socket) {
  return new Promise((resolve, reject) => {
    socket.once("readable", () => {
      const buffer: Buffer = socket.read(9);
      if (buffer.equals(settingsACKFrame)) {
        resolve(true);
      }
      reject("not settingsACKFrame");
    });
  });
}

function waitForLocalSettings(http2Session: Http2Session) {
  return new Promise((resolve) => http2Session.once("localSettings", resolve));
}

function waitForRemoteSettings(http2Session: Http2Session) {
  return new Promise<Settings>((resolve) =>
    http2Session.once("remoteSettings", resolve),
  );
}

async function waitForSecureConnect(tlsSocket: TLSSocket) {
  return new Promise((resolve) => tlsSocket.on("secureConnect", resolve));
}

async function http2ConnectionPreface(socket: Socket, settingsFrame?: Buffer) {
  socket.write(Buffer.concat([magic, settingsFrame || emptySettingsFrame]));
  await waitForSettingsFrameAndAckBack(socket);
  await waitForSettingsACKFrame(socket);
}

function getDataFrame(params: {
  streamID: number;
  flags: number;
  data: Buffer;
  /**
   * 0 ~ 255
   */
  padLength?: number;
  /**
   * 非 RFC 9113 設定，這是黑箱測試才會用到的
   */
  paddingFill?: Parameters<Buffer["fill"]>[0];
}) {
  const { streamID, flags, data, paddingFill } = params;
  const streamIDBuffer = numberTo4BytesBuffer(streamID);
  const padLength =
    typeof params.padLength === "number"
      ? numberTo1ByteBuffer(params.padLength)
      : Buffer.alloc(0);
  const padding = Buffer.alloc(params.padLength || 0, paddingFill);
  const payloadLength = numberTo3BytesBuffer(
    data.byteLength + Buffer.byteLength(padLength) + Buffer.byteLength(padding),
  );
  // prettier-ignore
  return Buffer.from([
    ...payloadLength,  // Length
    0x00,              // Type
    flags,             // Flags
    ...streamIDBuffer, // Reserved + Stream Identifier
    ...padLength,      // Pad Length
    ...data,           // Payload
    ...padding,        // Padding
  ]);
}

function getSettingsFrame(params: {
  SETTINGS_HEADER_TABLE_SIZE?: number;
  SETTINGS_ENABLE_PUSH?: number;
  SETTINGS_MAX_CONCURRENT_STREAMS?: number;
  SETTINGS_INITIAL_WINDOW_SIZE?: number;
  SETTINGS_MAX_FRAME_SIZE?: number;
  SETTINGS_MAX_HEADER_LIST_SIZE?: number;
}) {
  const {
    SETTINGS_HEADER_TABLE_SIZE,
    SETTINGS_ENABLE_PUSH,
    SETTINGS_MAX_CONCURRENT_STREAMS,
    SETTINGS_INITIAL_WINDOW_SIZE,
    SETTINGS_MAX_FRAME_SIZE,
    SETTINGS_MAX_HEADER_LIST_SIZE,
  } = params;

  // prettier-ignore
  const payload = Buffer.concat([
    typeof SETTINGS_HEADER_TABLE_SIZE === "number"
      ? Buffer.from([
          0x00,
          0x01,
          ...numberTo4BytesBuffer(SETTINGS_HEADER_TABLE_SIZE),
        ])
      : Buffer.alloc(0),
    typeof SETTINGS_ENABLE_PUSH === "number"
      ? Buffer.from([
          0x00,
          0x02,
          ...numberTo4BytesBuffer(SETTINGS_ENABLE_PUSH)
        ])
      : Buffer.alloc(0),
    typeof SETTINGS_MAX_CONCURRENT_STREAMS === "number"
      ? Buffer.from([
          0x00,
          0x03,
          ...numberTo4BytesBuffer(SETTINGS_MAX_CONCURRENT_STREAMS),
        ])
      : Buffer.alloc(0),
    typeof SETTINGS_INITIAL_WINDOW_SIZE === "number"
      ? Buffer.from([
          0x00,
          0x04,
          ...numberTo4BytesBuffer(SETTINGS_INITIAL_WINDOW_SIZE),
        ])
      : Buffer.alloc(0),
    typeof SETTINGS_MAX_FRAME_SIZE === "number"
      ? Buffer.from([
          0x00,
          0x05,
          ...numberTo4BytesBuffer(SETTINGS_MAX_FRAME_SIZE),
        ])
      : Buffer.alloc(0),
    typeof SETTINGS_MAX_HEADER_LIST_SIZE === "number"
      ? Buffer.from([
          0x00,
          0x06,
          ...numberTo4BytesBuffer(SETTINGS_MAX_HEADER_LIST_SIZE),
        ])
      : Buffer.alloc(0),
  ]);
  const length = numberTo3BytesBuffer(payload.length);
  // prettier-ignore
  return Buffer.from([
    ...length,              // Length
    0x04,                   // Type
    0x00,                   // Flags
    0x00, 0x00, 0x00, 0x00, // Reserved + Stream Identifier
    ...payload
  ]);
}

function getHeadersFrame(params: {
  streamID: number;
  /**
   * https://datatracker.ietf.org/doc/html/rfc9113#name-headers
   *
   * Unused Flags 64, 128
   *
   * PRIORITY Flag 32
   *
   * Unused Flag 16
   *
   * PADDED Flag  8
   *
   * END_HEADERS Flag  4
   *
   * Unused Flag  2
   *
   * END_STREAM Flag  1
   */
  flags: number;
  isContinuationFrame?: boolean;
  fieldBlockFragment: Buffer;
  /**
   * 0 ~ 255
   */
  padLength?: number;
  /**
   * 非 RFC 9113 設定，這是黑箱測試才會用到的
   */
  paddingFill?: Parameters<Buffer["fill"]>[0];
}) {
  const {
    streamID,
    flags,
    isContinuationFrame,
    fieldBlockFragment,
    paddingFill,
  } = params;
  const type = isContinuationFrame ? 0x09 : 0x01;
  const output_length = fieldBlockFragment.byteLength;
  const streamIDBuffer = numberTo4BytesBuffer(streamID);
  const padLength =
    typeof params.padLength === "number"
      ? numberTo1ByteBuffer(params.padLength)
      : Buffer.alloc(0);
  const padding = Buffer.alloc(params.padLength || 0, paddingFill);
  const payloadLength = numberTo3BytesBuffer(
    output_length + Buffer.byteLength(padLength) + Buffer.byteLength(padding),
  );
  // prettier-ignore
  return Buffer.from([
    ...payloadLength,      // Length
    type,                  // Type
    flags,                 // Flags
    ...streamIDBuffer,     // Reserved + Stream Identifier
    ...padLength,          // Pad Length
    ...fieldBlockFragment, // Payload
    ...padding,            // Padding
  ]);
}

function getGoawayFrame(params: {
  lastStreamID: number;
  /**
   * {@link ERROR_CODES}
   */
  errorCode: number;
  additionalDebugData?: Buffer;
}) {
  const {
    lastStreamID,
    errorCode,
    additionalDebugData = Buffer.alloc(0),
  } = params;
  const lastStreamIDBuffer = numberTo4BytesBuffer(lastStreamID);
  const errorCodeBuffer = numberTo4BytesBuffer(errorCode);
  const frameLength = numberTo3BytesBuffer(
    4 + 4 + additionalDebugData.byteLength,
  );
  // prettier-ignore
  return Buffer.from([
    ...frameLength,         // Length
    0x07,                   // Type
    0x00,                   // Flags
    0x00, 0x00, 0x00, 0x00, // Reserved + Stream Identifier
    ...lastStreamIDBuffer,  // Reserved + Last-Stream-ID
    ...errorCodeBuffer,     // Error Code
    ...additionalDebugData, // Additional Debug Data
  ]);
}

function getCustomPayloadRSTFrame(params: {
  streamID: number;
  payload?: Buffer;
}) {
  const payload = params.payload || Buffer.alloc(0);
  const byteLength = numberTo3BytesBuffer(payload.byteLength || 0);
  const streamIDBuffer = numberTo4BytesBuffer(params.streamID);
  // prettier-ignore
  return Buffer.from([
    ...byteLength,     // Length
    0x03,              // Type
    0x00,              // Flags
    ...streamIDBuffer, // Reserved + Stream Identifier
    ...payload,        // Payload
  ]);
}

function getRSTFrame(params: {
  streamID: number;
  /**
   * {@link ERROR_CODES}
   */
  errorCode: number;
}) {
  const streamIDBuffer = numberTo4BytesBuffer(params.streamID);
  const errorCodeBuffer = numberTo4BytesBuffer(params.errorCode);
  // prettier-ignore
  return Buffer.from([
    0x00, 0x00, 0x04,   // Length
    0x03,               // Type
    0x00,               // Flags
    ...streamIDBuffer,  // Reserved + Stream Identifier
    ...errorCodeBuffer, // Error Code
  ]);
}

function getWindowUpdateFrame(params: {
  streamID: number;
  windowSizeIncrement: number;
}) {
  const { streamID, windowSizeIncrement } = params;
  const streamIDBuffer = numberTo4BytesBuffer(streamID);
  const windowSizeIncrementBuffer = numberTo4BytesBuffer(windowSizeIncrement);
  // prettier-ignore
  return Buffer.from([
    0x00, 0x00, 0x04,             // Length
    0x08,                         // Type
    0x00,                         // Flags
    ...streamIDBuffer,            // Reserved + Stream Identifier
    ...windowSizeIncrementBuffer, // Window Size Increment
  ]);
}

function encodeOverlongIntegerRFC7541(params: {
  /**
   * "1"    => Huffman encoded
   *
   * "1"    => Indexed Header Field Representation
   *
   * "01"   => Literal Header Field with Incremental Indexing
   *
   * "001"  => Dynamic Table Size Update
   *
   * "0000" => Literal Header Field without Indexing
   *
   * "0001" => Literal Header Field Never Indexed
   */
  prefix: "1" | "01" | "001" | "0000" | "0001";
  /**
   * @see {@link HPACK_STATIC_TABLE} when prefix = "1", "01", "0000", "0001"
   */
  integer: number;
  additionalBytesCount: number;
}) {
  const { prefix, integer, additionalBytesCount } = params;
  const N = 8 - prefix.length;
  const maxN = 2 ** N - 1;
  if (integer < maxN) throw new Error(`integer must >= ${maxN}`);

  const bytes: number[] = [];
  // 第一個 byte 固定是 xxx11111
  bytes.push(parseInt(prefix + "1".repeat(N), 2));

  let remainBits = (integer - maxN).toString(2);
  const originalRemainBytesCount = Math.ceil(remainBits.length / 7);
  const finalRemainBytesCount = originalRemainBytesCount + additionalBytesCount;
  const remainBitsArray: string[] = [];
  while (remainBits.length > 7) {
    remainBitsArray.push(remainBits.slice(-7));
    remainBits = remainBits.slice(0, -7);
  }
  if (remainBits.length > 0) remainBitsArray.push(remainBits.padStart(7, "0"));

  for (let i = 0; i < finalRemainBytesCount; i++) {
    const continuation = i === finalRemainBytesCount - 1 ? "0" : "1";
    if (remainBitsArray[i])
      bytes.push(parseInt(`${continuation}${remainBitsArray[i]}`, 2));
    if (!remainBitsArray[i]) bytes.push(parseInt(`${continuation}0000000`, 2));
  }
  return Buffer.from(bytes);
}

const MAX_7_BIT_VALUE = 0b01111111;
const LOW_7_BITS_MASK = 0b01111111;
const CONTINUATION_FLAG = 0b10000000;
function encodeIntegerRFC7541(params: {
  /**
   * "1"    => Huffman encoded
   *
   * "1"    => Indexed Header Field Representation
   *
   * "01"   => Literal Header Field with Incremental Indexing
   *
   * "001"  => Dynamic Table Size Update
   *
   * "0000" => Literal Header Field without Indexing
   *
   * "0001" => Literal Header Field Never Indexed
   */
  prefix: "1" | "01" | "001" | "0000" | "0001";
  /**
   * @see {@link HPACK_STATIC_TABLE} when prefix = "1", "01", "0000", "0001"
   */
  integer: number;
}): Buffer {
  const { prefix, integer } = params;

  const N = 8 - prefix.length;

  // 1 << N：將數字 1 的二進位向左移動 N 個位元
  // 數學意義等同於 1 x 2^N（即 2 的 N 次方）
  const maxN = (1 << N) - 1;

  // 將 prefix 二進位字串轉為數值，並向左位移至高位元
  const prefixVal = parseInt(prefix, 2) << N;

  const bytes: number[] = [];

  // 1 個 byte 就能編碼
  if (integer < maxN) {
    // Bitwise OR
    // 1000,0000
    // 0000,1111
    // ---------
    // 1000,1111
    bytes.push(prefixVal | integer);
    return Buffer.from(bytes);
  }

  // 需要多個 bytes 來編碼
  bytes.push(prefixVal | maxN);
  let remaining = integer - maxN;
  while (remaining > MAX_7_BIT_VALUE) {
    // 低 7 位的資料 跟 CONTINUATION_FLAG 做 Bitwise OR
    bytes.push((remaining & LOW_7_BITS_MASK) | CONTINUATION_FLAG);
    // 數值右移 7 位，準備處理下一組
    remaining >>>= 7;
  }
  // 剩下來的最後一組數值，因為小於等於 127，MSB 自動為 0，代表結束
  bytes.push(remaining);

  return Buffer.from(bytes);
}

/**
 * @link https://datatracker.ietf.org/doc/html/rfc7541#section-5.2
 */
function encodeStringLiteralsRFC7541(params: {
  huffman?: boolean;
  string: string;
  /**
   * 刻意創造不合法的 string literal 才會需要
   *
   * @example "1110"
   */
  customPaddingBits?: string;
  /**
   * 刻意創造不合法的 string literal 才會需要
   *
   * @example Buffer.from([0x7f])
   */
  additionalBytes?: Buffer;
}) {
  const {
    huffman,
    string,
    customPaddingBits = "",
    additionalBytes = Buffer.alloc(0),
  } = params;
  if (!huffman) {
    return Buffer.concat([
      // FIXME: 字串 ≥ 128 bytes 會出錯
      Buffer.from([Buffer.byteLength(string)]),
      Buffer.from(string, "ascii"),
    ]);
  }

  let stringBits = "";
  // 針對每個 chart 查詢 HUFFMAN_CODE
  for (const char of string) {
    const codePoint = Number(char.codePointAt(0));
    if (codePoint > 255) throw new Error("invalid string");
    stringBits += HUFFMAN_CODE[codePoint];
  }
  console.log("stringBits.length", stringBits.length);
  if (customPaddingBits) {
    assert((stringBits.length + customPaddingBits.length) % 8 === 0);
    stringBits += customPaddingBits;
  }
  // bits 尾巴補 1
  if (!customPaddingBits && stringBits.length % 8 !== 0) {
    stringBits += "1".repeat(8 - (stringBits.length % 8));
  }
  // bits 轉 bytes
  const stringBytes = Buffer.from(Array(stringBits.length / 8).fill(0x00));
  for (let i = 0; i < stringBits.length; i += 8) {
    stringBytes[i / 8] = parseInt(stringBits.slice(i, i + 8), 2);
  }
  return Buffer.concat([
    encodeIntegerRFC7541({
      prefix: "1",
      integer:
        Buffer.byteLength(stringBytes) + Buffer.byteLength(additionalBytes),
    }),
    stringBytes,
    additionalBytes,
  ]);
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function writeAsync(
  writable: Writable,
  buffer: Parameters<Writable["write"]>[0],
) {
  return new Promise((resolve) => writable.write(buffer, resolve));
}

function onceData(socket: Socket | TLSSocket) {
  return new Promise<Buffer<ArrayBuffer>>((resolve) =>
    socket.on("data", resolve),
  );
}

function getFileName(importMetaFilename: string) {
  const segments =
    process.platform === "win32"
      ? importMetaFilename.split("\\")
      : importMetaFilename.split("/");
  return segments[segments.length - 1];
}

export {
  HPACK_STATIC_TABLE,
  magic,
  emptySettingsFrame,
  pingFrame,
  settingsACKFrame,
  encodeIntegerRFC7541,
  encodeOverlongIntegerRFC7541,
  encodeStringLiteralsRFC7541,
  numberTo1ByteBuffer,
  numberTo3BytesBuffer,
  numberTo4BytesBuffer,
  getCustomPayloadRSTFrame,
  getRSTFrame,
  ERROR_CODES,
  getGoawayFrame,
  getDataFrame,
  getSettingsFrame,
  getHeadersFrame,
  getWindowUpdateFrame,
  waitForSecureConnect,
  waitForLocalSettings,
  waitForRemoteSettings,
  waitForSettingsACKFrame,
  waitForSettingsFrameAndAckBack,
  http2ConnectionPreface,
  sleep,
  writeAsync,
  getFileName,
  onceData,
};
