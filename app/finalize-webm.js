"use strict";
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
// Copy compressed packets without decoding/encoding. A seekable file output
// lets the WebM muxer write Duration, SeekHead, and Cues on completion.

// 별도 창 없이 FFmpeg를 실행하여 탐색 가능한 WebM 생성
async function finalizeWebm(binary, input, output) {
  await new Promise((resolve, reject) => {
    let tail = "";
    const child = spawn(
      binary,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-n",
        "-i",
        input,
        "-map",
        "0:v:0",
        "-c:v",
        "copy",
        "-an",
        "-f",
        "webm",
        output,
      ],
      { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
    );
    child.stderr.on("data", (data) => {
      tail = (tail + data.toString()).slice(-4000);
    });
    child.once("error", (e) =>
      reject(
        Error("영상 탐색 정보 처리 도구를 실행하지 못했습니다: " + e.message),
      ),
    );
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(Error("영상 탐색 정보 처리 실패: " + tail.trim())),
    );
  });

  // 결과 파일의 존재와 크기를 확인하고 디스크에 동기화
  const info = await fs.stat(output);
  if (info.size === 0) throw Error("탐색 정보 처리 결과가 비어 있습니다.");
  const handle = await fs.open(output, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
module.exports = { finalizeWebm };
