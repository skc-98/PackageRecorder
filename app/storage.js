"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

// 저장 경로와 현재 녹화 파일을 관리
class RecordingStore {
  constructor(finalize = null) {
    this.finalize = finalize;
    this.root = null;
    this.directory = null;
    this.current = null;
  }

  // 사용자가 선택한 저장 폴더 확인
  async select(root) {
    if (this.current)
      throw Error("녹화 중에는 저장 위치를 변경할 수 없습니다.");
    if (!(await fs.stat(root)).isDirectory()) throw Error("폴더가 아닙니다.");
    this.root = root;
    this.directory = null;
    return root;
  }

  // 날짜 형식을 검증하고 기존 날짜 폴더는 재사용
  async prepare(date) {
    if (this.current) throw Error("녹화 중입니다.");
    if (!this.root) throw Error("저장 위치를 선택해 주세요.");
    if (
      typeof date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      new Date(date + "T00:00:00Z").toISOString().slice(0, 10) !== date
    )
      throw Error("올바른 날짜를 선택해 주세요.");
    const target = path.join(this.root, date);
    await fs.mkdir(target, { recursive: true });
    // Reject symlinks so recordings stay in the selected date directory.
    if ((await fs.lstat(target)).isSymbolicLink())
      throw Error("날짜 폴더가 바로가기입니다. 다른 위치를 선택하세요.");
    this.directory = target;
    return target;
  }

  // 안전한 고유 파일명으로 미완료 녹화 파일 생성
  async begin(order) {
    if (this.current) throw Error("이미 녹화 중입니다.");
    if (!this.directory) throw Error("날짜 폴더를 먼저 준비하세요.");
    if (typeof order !== "string" || !order.trim())
      throw Error("주문번호를 입력하세요.");
    let safe =
      order
        .trim()
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
        .replace(/[. ]+$/, "")
        .slice(0, 80) || "order";
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe))
      safe = "order_" + safe;
    const name =
      safe +
      "_" +
      new Date().toISOString().replace(/[:.]/g, "-") +
      "_" +
      randomUUID().slice(0, 8) +
      ".webm";
    const final = path.join(this.directory, name),
      partial = final + ".partial";
    const handle = await fs.open(partial, "wx");
    this.current = { handle, final, partial, name, bytes: 0 };
    return { name, partial };
  }

  // 영상 조각의 모든 바이트가 기록될 때까지 순차 쓰기
  async append(data) {
    const c = this.current;
    if (!c) throw Error("녹화 파일이 없습니다.");
    if (!(data instanceof Uint8Array) || data.byteLength > 32 * 1024 * 1024)
      throw Error("잘못된 영상 데이터입니다.");
    let offset = 0;
    while (offset < data.byteLength) {
      const { bytesWritten } = await c.handle.write(
        data,
        offset,
        data.byteLength - offset,
      );
      if (!bytesWritten) throw Error("디스크에 쓸 수 없습니다.");
      offset += bytesWritten;
      c.bytes += bytesWritten;
    }
    return c.bytes;
  }

  // 디스크 동기화와 탐색 정보 처리가 끝나야 최종 저장 완료
  async finish() {
    const c = this.current;
    if (!c) throw Error("녹화 파일이 없습니다.");
    try {
      await c.handle.sync();
      await c.handle.close();
      if (!c.bytes) {
        await fs.unlink(c.partial);
        throw Error("저장할 영상 데이터가 없습니다.");
      }
      let warning = null;
      if (this.finalize) {
        const staged = c.final + ".indexing";
        try {
          await this.finalize(c.partial, staged);
          await fs.rename(staged, c.final);
        } catch (e) {
          await fs.unlink(staged).catch(() => {});
          throw Error(e.message + " 원본 보존: " + c.partial);
        }
        await fs.unlink(c.partial).catch(() => {
          warning =
            "영상은 저장됐지만 임시 원본을 삭제하지 못했습니다: " + c.partial;
        });
      } else await fs.rename(c.partial, c.final);
      return {
        name: c.name,
        path: c.final,
        bytes: (await fs.stat(c.final)).size,
        warning,
      };
    } catch (e) {
      await c.handle.close().catch(() => {});
      throw e;
    } finally {
      this.current = null;
    }
  }

  // 오류 시 원본 파일을 삭제하지 않고 닫기
  async abandon() {
    const c = this.current;
    if (!c) return null;
    this.current = null;
    await c.handle.close().catch(() => {});
    return c.partial;
  }
}
module.exports = { RecordingStore };
