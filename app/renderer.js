"use strict";

// 화면 요소와 시스템 기능 연결
const $ = (id) => document.getElementById(id),
  api = window.recorderApp;

// 녹화 상태와 순차 저장 대기열
let root = "",
  directory = "",
  active = false,
  paused = false,
  busy = false,
  compact = false,
  media = null,
  stream = null,
  elapsed = 0,
  started = 0,
  writeQueue = Promise.resolve(),
  writeError = null,
  pendingBytes = 0,
  logs = [],
  toastTimer;

// 기본 작업 날짜는 PC의 오늘 날짜
const today = new Date();
$("date").value = [
  today.getFullYear(),
  String(today.getMonth() + 1).padStart(2, "0"),
  String(today.getDate()).padStart(2, "0"),
].join("-");

// 잠시 표시되는 상태 알림
function toast(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 6500);
}

// 저장 위치와 시작 버튼 상태 갱신
function update() {
  $("location").textContent = root || "폴더 또는 이동식 디스크를 선택하세요";
  $("target").textContent = root
    ? root + "\\" + $("date").value
    : "저장 위치를 먼저 선택해 주세요.";
  $("start").disabled = !root || !$("date").value || busy;
}

// 밀리초를 시:분:초로 표시
function formatTime(ms) {
  const s = Math.floor(ms / 1000);
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60]
    .map((x) => String(x).padStart(2, "0"))
    .join(":");
}

// 녹화 상태에 맞춰 버튼과 표시 문구 갱신
function controls() {
  $("record").disabled = active || busy || !stream;
  $("pause").disabled = !active || busy;
  $("stop").disabled = !active || busy;
  $("order").disabled = active || busy;
  $("settings").disabled = active || busy;
  $("connect").disabled = active || busy;
  $("device").disabled = active || busy;
  $("pause").textContent = paused ? "▶" : "Ⅱ";
  $("pause").title = paused ? "녹화 재개" : "일시정지";
  $("pause").setAttribute("aria-label", $("pause").title);
  $("state").textContent = busy
    ? "저장 처리 중"
    : active
      ? paused
        ? "일시정지"
        : "녹화 중"
      : stream
        ? "녹화 대기"
        : "카메라 연결 필요";
  $("screen").classList.toggle("recording", active && !paused);
}
$("date").onchange = update;

// Windows 폴더 선택 창 열기
$("browse").onclick = async () => {
  try {
    const selected = await api.chooseFolder();
    if (selected) {
      root = selected;
      update();
    }
  } catch (e) {
    toast(e.message);
  }
};

// 날짜 폴더를 준비하고 녹화 화면으로 이동
$("start").onclick = async () => {
  busy = true;
  update();
  try {
    directory = await api.prepareDate($("date").value);
    $("savepath").textContent = directory;
    $("setup").hidden = true;
    $("recorder").hidden = false;
    $("order").focus();
    toast("날짜 폴더 준비 완료 · 기존 폴더는 그대로 사용합니다.");
    if (!stream) await connectCamera();
  } catch (e) {
    toast(e.message);
  } finally {
    busy = false;
    update();
    controls();
  }
};

// 선택한 카메라 연결 및 기존 스트림 정리
async function connectCamera(deviceId) {
  if (active) return;
  try {
    const next = await navigator.mediaDevices.getUserMedia({
      video: deviceId
        ? {
            deviceId: { exact: deviceId },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          }
        : { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    const previous = stream;
    stream = next;
    $("camera").srcObject = next;
    $("camera").hidden = false;
    previous?.getTracks().forEach((t) => t.stop());
    const actual = next.getVideoTracks()[0].getSettings().deviceId;
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(
      (d) => d.kind === "videoinput",
    );
    $("device").replaceChildren();
    devices.forEach((d, i) => {
      const o = document.createElement("option");
      o.value = d.deviceId;
      o.textContent = d.label || "카메라 " + (i + 1);
      $("device").append(o);
    });
    $("device").value = actual || "";
    next.getVideoTracks()[0].onended = () => {
      if (stream !== next) return;
      stream = null;
      $("camera").hidden = true;
      if (active) {
        toast("카메라 연결이 끊어져 현재 영상을 저장합니다.");
        stopRecording();
      } else toast("카메라 연결이 끊어졌습니다.");
      controls();
    };
    $("connect").textContent = "다시 연결";
  } catch (e) {
    toast(
      "카메라를 연결하지 못했습니다. USB 연결 및 Windows 카메라 권한을 확인하세요.",
    );
  }
  controls();
}
$("connect").onclick = () => connectCamera($("device").value || undefined);
$("device").onchange = () => connectCamera($("device").value);

// 실제 Windows 창을 소형/큰 화면으로 전환
$("size").onclick = async () => {
  try {
    compact = await api.compact(!compact);
    document.body.classList.toggle("compact", compact);
    $("size").textContent = compact ? "□" : "▱";
    $("size").title = compact ? "최대 화면으로" : "소형 화면으로";
    $("size").setAttribute("aria-label", $("size").title);
  } catch (e) {
    toast(e.message);
  }
};

// 녹화 종료 후 저장 설정 화면으로 복귀
$("settings").onclick = async () => {
  if (active || busy) return;
  try {
    if (compact) {
      await api.compact(false);
      compact = false;
      document.body.classList.remove("compact");
      $("size").textContent = "▱";
      $("size").title = "소형 화면으로";
      $("size").setAttribute("aria-label", "소형 화면으로");
    }
    $("recorder").hidden = true;
    $("setup").hidden = false;
  } catch (e) {
    toast(e.message);
  }
};
$("openfolder").onclick = async () => {
  try {
    await api.openFolder();
  } catch (e) {
    toast(e.message);
  }
};

// 주문번호 확인 후 녹화 시작
$("record").onclick = async () => {
  if (active || busy) return;
  if (!$("order").value.trim()) return toast("주문번호를 먼저 입력해 주세요.");
  if (!stream) return toast("카메라를 연결하세요.");
  busy = true;
  controls();
  try {
    const mime = ["video/webm;codecs=vp8", "video/webm"].find((t) =>
      MediaRecorder.isTypeSupported(t),
    );
    if (!mime) throw Error("영상 녹화 형식을 지원하지 않습니다.");
    media = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: 4000000,
    });
    await api.begin($("order").value.trim());
    writeQueue = Promise.resolve();
    writeError = null;
    pendingBytes = 0;

    // 영상 조각을 발생 순서대로 디스크에 기록
    media.ondataavailable = (e) => {
      if (!e.data.size) return;
      pendingBytes += e.data.size;
      writeQueue = writeQueue
        .then(async () => {
          if (writeError) return;
          try {
            await api.append(new Uint8Array(await e.data.arrayBuffer()));
          } catch (error) {
            writeError = error;
          } finally {
            pendingBytes -= e.data.size;
          }
        })
        .then(() => {
          if (
            (writeError || pendingBytes > 64 * 1024 * 1024) &&
            active &&
            !busy
          ) {
            if (!writeError)
              writeError = Error("저장 장치가 느려 녹화를 중단했습니다.");
            stopRecording();
          }
        });
    };
    media.onerror = () => {
      writeError = Error("카메라 녹화에 오류가 발생했습니다.");
      if (active && !busy) stopRecording();
    };
    media.onstop = () => {
      if (active && !busy) stopRecording();
    };
    media.start(1000);
    elapsed = 0;
    started = performance.now();
    active = true;
    paused = false;
  } catch (e) {
    await api.abandon().catch(() => {});
    media = null;
    toast("녹화를 시작하지 못했습니다: " + e.message);
  } finally {
    busy = false;
    controls();
  }
};

// 일시정지 시간을 제외하여 녹화 시간 계산
$("pause").onclick = () => {
  if (!active || busy) return;
  try {
    if (paused) {
      media.resume();
      started = performance.now();
      paused = false;
    } else {
      media.pause();
      elapsed += performance.now() - started;
      paused = true;
    }
    controls();
  } catch (e) {
    toast(e.message);
  }
};

// 남은 영상 조각을 저장하고 탐색 정보를 마무리
async function stopRecording() {
  if (!active || busy) return;
  busy = true;
  const duration = elapsed + (paused ? 0 : performance.now() - started),
    order = $("order").value.trim();
  controls();
  try {
    if (media.state !== "inactive")
      await new Promise((resolve) => {
        media.addEventListener("stop", resolve, { once: true });
        media.stop();
      });
    await writeQueue;
    if (writeError) {
      const partial = await api.abandon();
      throw Error(writeError.message + " 미완료 파일: " + partial);
    }
    $("state").textContent = "탐색 정보 정리 중";
    const saved = await api.finish();
    logs.unshift({ order, duration, path: saved.path, name: saved.name });
    renderLogs();
    $("order").value = "";
    toast(saved.warning || "영상 저장 완료: " + saved.name);
  } catch (e) {
    await api.abandon().catch(() => {});
    toast("저장 확인 필요: " + e.message);
    const line = document.createElement("div");
    line.className = "log error";
    line.textContent = "저장 오류: " + e.message;
    $("logs").prepend(line);
  } finally {
    active = false;
    busy = false;
    paused = false;
    media = null;
    elapsed = 0;
    $("timer").textContent = "00:00:00";
    controls();
    $("order").focus();
  }
}
$("stop").onclick = stopRecording;

// 이번 실행에서 저장한 영상 목록 표시
function renderLogs() {
  $("count").textContent = logs.length;
  $("logs").replaceChildren();
  logs.forEach((l) => {
    const d = document.createElement("div");
    d.className = "log";
    d.textContent = l.order;
    d.title = l.path;
    const small = document.createElement("small");
    small.textContent = formatTime(l.duration) + " · 저장 완료";
    d.append(small);
    $("logs").append(d);
  });
}

// 주문번호 입력 후 Enter로 녹화 시작
$("order").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !$("record").disabled) $("record").click();
});
setInterval(() => {
  if (active)
    $("timer").textContent = formatTime(
      elapsed + (paused ? 0 : performance.now() - started),
    );
}, 200);

// 카메라 연결 전 안내 화면
const c = $("canvas").getContext("2d");
c.fillStyle = "#17232e";
c.fillRect(0, 0, 960, 540);
c.textAlign = "center";
c.fillStyle = "#8a9eb2";
c.font = "22px sans-serif";
c.fillText("카메라를 연결해 주세요", 480, 275);
controls();
update();
