import { app } from "../../../scripts/app.js";
import { sendMsg, sendMsgImmediate } from "./connection.js";
import { isPsConnected, isWorkflowLoaded } from "./event.js";

export function AddHtmlWidget(node, name, element, height = 36) {
  if (typeof element === "string") {
    const container = document.createElement("div");
    container.innerHTML = element;
    element = container;
  }
  element.classList.add("ps-v3-widget");
  return node.addDOMWidget(name, "ps-v3", element, {
    serialize: false,
    getMinHeight: () => height,
    getMaxHeight: () => height,
  });
}

export function brandStyle(node) {
  const defaults = {
    "🔹Photoshop Images": "MAIN DOC",
    "🔹Photoshop Strings": "+ PROMPT",
    "🔹Floats": "MAIN",
    "🔹SeedManager": "SEED",
  };
  node.title = defaults[node.comfyClass] || node.title.replace(/^🔹\s*/, "");
  const applyAppearance = () => {
    // Keep custom workflow colors; migrate only the previous plugin defaults.
    if (!node.color || ["#000000", "#26394b"].includes(node.color.toLowerCase())) node.color = "#282828";
    if (!node.bgcolor || ["#1a1e24", "#1d2630"].includes(node.bgcolor.toLowerCase())) node.bgcolor = "#212121";
    for (const widget of node.widgets || []) {
      widget.inputEl?.classList.add("ps-v3-native-input");
    }
  };
  applyAppearance();
  const onConfigure = node.onConfigure;
  node.onConfigure = function (...args) {
    const result = onConfigure?.apply(this, args);
    applyAppearance();
    return result;
  };
}

function prepareList(list, priority = []) {
  if (!Array.isArray(priority)) priority = [priority];
  return list.map(item => ({
    ...item,
    active: item.ids?.some(id => app.graph.getNodeById(id)?.mode === 0) ? 1 : 0,
  })).sort((a, b) => {
    const rank = title => priority.includes(title) ? priority.indexOf(title) : priority.length;
    return rank(a.title) - rank(b.title);
  });
}

// Reconnection and workflow loads resend complete state, including unchanged values.
export async function sendList(type, list, priority) {
  if (isWorkflowLoaded && isPsConnected) return sendMsg(type, prepareList(list, priority));
}
export async function sendListImmediate(type, list, priority) {
  if (isWorkflowLoaded && isPsConnected) return sendMsgImmediate(type, prepareList(list, priority));
}
