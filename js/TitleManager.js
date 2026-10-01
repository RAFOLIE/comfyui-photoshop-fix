import e from "./event.js";
import { AddHtmlWidget } from "./utils.js";
import { groups } from "./slots.js";

const types = new Map();
let nextId = 0;

export function manageNameList(node, msgType, suggestions = []) {
  types.set(msgType, node.comfyClass);
  const row = document.createElement("label");
  row.classList.add("ps-v3-sync");
  const isPrompt = msgType === "StringSlots";
  const caption = document.createElement("span");
  caption.textContent = isPrompt ? "提示词类型" : "同步名称";
  row.append(caption);
  const input = document.createElement(isPrompt ? "select" : "input");
  if (!isPrompt) input.type = "text";
  input.value = node.title;
  input.setAttribute("aria-label", isPrompt ? "提示词类型" : "同步名称（需与 Photoshop 中的名称一致）");
  const options = isPrompt ? input : document.createElement("datalist");
  if (!isPrompt) {
    options.id = `ps-slot-names-${++nextId}`;
    input.setAttribute("list", options.id);
  }
  row.append(input);
  if (!isPrompt) row.append(options);
  const refresh = () => {
    input.value = node.title;
    const names = new Set([...suggestions, ...groups(node.comfyClass).map(group => group.title), node.title]);
    options.replaceChildren(...[...names].map(name => {
      const option = document.createElement("option");
      option.value = name;
      if (isPrompt) option.textContent = ({"+ PROMPT": "正提示词", "- PROMPT": "负提示词"})[name] || name;
      return option;
    }));
    input.value = node.title;
  };
  input.addEventListener("focus", refresh);
  input.addEventListener("change", () => {
    const title = input.value.trim();
    if (!title) return refresh();
    node.title = title;
    node.onTitleChanged?.(title);
    node.setDirtyCanvas(true, true);
  });
  const onTitleChanged = node.onTitleChanged;
  node.onTitleChanged = function (...args) {
    const result = onTitleChanged?.apply(this, args);
    refresh();
    e.emit("slotsChanged", this);
    return result;
  };
  AddHtmlWidget(node, "sync_name", row);
  refresh();
  return refresh;
}

export async function getTitleInfoMap(msgType) {
  const type = types.get(msgType);
  return type ? groups(type).map(({title, ids}) => ({title, ids})) : [];
}
