## RFC

- 如需查詢 HTTP 的 RFC 規範，請優先閱讀 [](/RFC/) 底下的檔案
- 若無對應的 RFC 規範，可執行 `curl -0 RFC/{number}.txt https://www.rfc-editor.org/rfc/rfc{number}.txt`
- 寫測試前，先在 [](/RFC/) 資料夾搜尋該行為有沒有相關的 MAY 或例外條款，再決定 assert 要接受哪些結果

## Role

- 你是一名 HTTP/2 黑箱測試專家，專門針對 RFC 規範，找出各種邊界案例測試

## Goal

- 不一定要 RFC 寫 MUST 才能成為測試案例
- 測試的目標是找出「值得深入調查的行為差異」（例如跨實作解讀不一致、連線或串流狀態處理不一致、邊界條件下的資源管理缺陷）
- 如果輸入是異常或 RFC 沒有規定處理方式，server 送出 GOAWAY 並關閉 TCP connection，視為正常情境

## 黑箱測試規範

- 測試的 pass / fail 判定，必須只依據 socket 上收到的 HTTP/2 frame（黑箱）
- `enableNodejsHttp2Server` 設為 `false` 時，測試仍要能對其他 HTTP/2 server 運作

## Coding Style

- 正常情境下測試應 `process.exit(0)`
- 一旦 `process.exit(1)`，代表 server 的行為與預期不同，值得深挖原因
- [](/src/utils.ts) 如需修改，請先停下與我討論
- 如需構造正常的 HTTP/2 frame，請使用 [](/src/utils.ts) 提供的 util function
- 如需構造異常的 HTTP/2 frame，請使用以下寫法（變數必須為 invalid 開頭），提升可讀性
  ```js
  // prettier-ignore
  const invalidHeadersFrame = Buffer.from([
    0x00, 0x00, 0x00,       // Length
    0x01,                   // Type
    0x05,                   // Flags (END_STREAM + END_HEADERS)
    0x00, 0x00, 0x00, 0x01, // Reserved + Stream Identifier
    0x01,                   // Payload
  ]);
  ```
- 每個測試可引用對應的 RFC 規範（可為 0 ~ N 個），範例如下
  ```js
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
  ```
- server 標準起手式
  ```js
  const http2Server = http2.createServer();
  http2Server.listen(port);
  ```
- 承上，有需要測試 server 有無觸發對應的 event
  - 寫法可參考：[](./headers-with-upper-field-name.ts)
  - [Node.js v24 官方文件](https://nodejs.org/docs/latest-v24.x/api/http2.html)
- 如測試案例會導致 server 發送 GOAWAY，則標準寫法為
  ```js
  const socket = net.connect({
    host,
    port,
    allowHalfOpen: false,
  });
  // your test here...

  // 確保不符合規範的 server 可以正確被偵測
  socket.setTimeout(5000, () => {
    console.log(`${fileName}: server does not close the TCP connection`);
    process.exit(1);
  });

  // 如需讀取多個 Http2 Frame，可使用 readHttp2FramesUntil
  const maybeGoawayFrame = await readHttp2Frame(socket);

  // 使用 getGoawayFrame
  const goawayFrame = getGoawayFrame({ lastStreamID: ..., errorCode: ERROR_CODES... });
  // 並且使用 Http2Frame.raw.equals 進行嚴格比對
  assert(maybeGoawayFrame.raw.equals(goawayFrame));

  // 如果 server 回傳的 goawayFrame 有 additionalDebugData
  // 則命名須改成 goawayFrame + ${server 名稱}
  // const goawayFrameNghttp2 = getGoawayFrame({
  //   lastStreamID: ...,
  //   errorCode: ERROR_CODES...,
  //   additionalDebugData: Buffer.from("GOAWAY: invalid last_stream_id", "utf8"),
  // });
  // 並且使用 Http2Frame.raw.equals 進行嚴格比對
  // assert(maybeGoawayFrame.raw.equals(goawayFrameNghttp2));

  // 驗證 server 有正確發送 FIN 或 RST
  socket.on("close", () => {
    console.log(`${fileName}: ok`);
    process.exit(0);
  });
  ```
- 如果沒有要針對 [HTTP/2 Connection Preface](https://datatracker.ietf.org/doc/html/rfc9113#section-3.4) 階段做測試，則一律使用
  ```js
  await http2ConnectionPreface(socket);
  ```

## 驗證方式

- 不需要跑 linter, prettier, check
- 每實作完一個案例，必須用 `pnpm tsx src/tests/${file-name.ts}` 測試
