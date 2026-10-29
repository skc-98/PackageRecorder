"use strict";
const { contextBridge, ipcRenderer } = require("electron");

// 시스템 처리 결과를 화면에 전달하고 오류는 예외로 통일
const invoke = async (channel, ...args) => {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result.ok) throw Error(result.error);
  return result.value;
};

// 화면에는 필요한 기능만 공개
contextBridge.exposeInMainWorld(
  "recorderApp",
  Object.freeze({
    chooseFolder: () => invoke("choose-folder"),
    prepareDate: (date) => invoke("prepare-date", date),
    begin: (order) => invoke("begin", order),
    append: (data) => invoke("append", data),
    finish: () => invoke("finish"),
    abandon: () => invoke("abandon"),
    openFolder: () => invoke("open-folder"),
    compact: (value) => invoke("compact", value),
  }),
);
