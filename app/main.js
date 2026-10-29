"use strict";
const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  session,
  shell,
  powerSaveBlocker,
  screen,
} = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { RecordingStore } = require("./storage");
const { finalizeWebm } = require("./finalize-webm");

// 녹화 종료 시 WebM을 재인코딩 없이 정리
const storage = new RecordingStore((input, output) =>
  finalizeWebm(
    path.join(process.resourcesPath, "tools", "ffmpeg.exe"),
    input,
    output,
  ),
);
let win,
  normalBounds,
  wasMax = false,
  blocker = null,
  queue = Promise.resolve(),
  closing = false;
const localURL = pathToFileURL(path.join(__dirname, "index.html")).href;

// 녹화 및 저장 중 시스템 절전 방지
function protect() {
  if (blocker === null)
    blocker = powerSaveBlocker.start("prevent-app-suspension");
}
function release() {
  if (blocker !== null) {
    powerSaveBlocker.stop(blocker);
    blocker = null;
  }
}

// 로컬 앱의 요청만 허용하고 파일 작업을 순서대로 처리
function register(name, fn) {
  ipcMain.handle(name, (event, ...args) => {
    if (event.sender !== win.webContents || event.senderFrame?.url !== localURL)
      throw Error("허용되지 않은 요청입니다.");
    const task = queue.then(() => fn(...args));
    queue = task.catch(() => {});
    return task.then(
      (value) => ({ ok: true, value }),
      (e) => ({ ok: false, error: e.message }),
    );
  });
}

// 앱 중복 실행 방지
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    app.setAppUserModelId("local.packageRecorder");

    // 앱 내부의 영상 카메라 접근만 허용
    session.defaultSession.setPermissionRequestHandler(
      (wc, permission, callback, details) =>
        callback(
          wc === win?.webContents &&
            wc.getURL() === localURL &&
            permission === "media" &&
            !(details.mediaTypes || []).includes("audio"),
        ),
    );
    session.defaultSession.setPermissionCheckHandler(
      (wc, permission) =>
        wc === win?.webContents &&
        wc.getURL() === localURL &&
        permission === "media",
    );

    // 화면에서는 Node.js 직접 접근을 막고 preload로 기능 연결
    win = new BrowserWindow({
      width: 1150,
      height: 880,
      minWidth: 760,
      minHeight: 640,
      title: "Packing Recorder",
      backgroundColor: "#edf1f5",
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    win.setMenu(null);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (e) => e.preventDefault());

    // 저장 위치 선택과 날짜 폴더 준비
    register("choose-folder", async () => {
      if (storage.current) throw Error("녹화 중입니다.");
      const result = await dialog.showOpenDialog(win, {
        title: "영상을 저장할 폴더 선택",
        properties: ["openDirectory", "createDirectory"],
        defaultPath: storage.root || app.getPath("videos"),
      });
      if (result.canceled) return null;
      return storage.select(result.filePaths[0]);
    });
    register("prepare-date", (date) => storage.prepare(date));

    // 녹화 파일 생성, 조각 저장, 종료 처리
    register("begin", async (order) => {
      const result = await storage.begin(order);
      protect();
      return result;
    });
    register("append", (data) => storage.append(data));
    register("finish", async () => {
      try {
        return await storage.finish();
      } finally {
        release();
      }
    });
    register("abandon", async () => {
      try {
        return await storage.abandon();
      } finally {
        release();
      }
    });
    register("open-folder", async () => {
      if (!storage.directory) throw Error("폴더를 먼저 선택하세요.");
      const error = await shell.openPath(storage.directory);
      if (error) throw Error(error);
    });

    // 소형 창은 항상 위에 표시하고 기존 창 위치는 기억
    register("compact", (compact) => {
      if (typeof compact !== "boolean") throw Error("잘못된 창 설정입니다.");
      if (compact) {
        normalBounds = win.getNormalBounds();
        wasMax = win.isMaximized();
        if (wasMax) win.unmaximize();
        win.setMinimumSize(440, 340);
        win.setSize(460, 380);
        const area = screen.getDisplayMatching(win.getBounds()).workArea;
        win.setPosition(area.x + area.width - 480, area.y + 30);
        win.setAlwaysOnTop(true);
      } else {
        win.setAlwaysOnTop(false);
        win.setMinimumSize(760, 640);
        if (normalBounds) win.setBounds(normalBounds);
        else win.setSize(1150, 880);
        if (wasMax) win.maximize();
      }
      return compact;
    });

    // 녹화 또는 저장 도중 창이 닫히지 않도록 보호
    win.on("close", (e) => {
      if (closing || !storage.current) return;
      e.preventDefault();
      dialog.showMessageBox(win, {
        type: "info",
        title: "녹화 중",
        message: "녹화를 정지하고 저장이 끝난 뒤 종료해 주세요.",
        buttons: ["확인"],
      });
    });

    // 화면 오류 시 미완료 파일을 보존하고 앱 종료
    win.webContents.on("render-process-gone", async () => {
      await queue;
      const partial = await storage.abandon();
      release();
      dialog.showErrorBox(
        "화면 오류",
        partial
          ? "미완료 영상이 남아 있습니다: " + partial
          : "앱 화면에 오류가 발생했습니다. 다시 실행해 주세요.",
      );
      closing = true;
      win.close();
    });
    win.loadFile("index.html");
  });
  app.on("window-all-closed", () => app.quit());
}
