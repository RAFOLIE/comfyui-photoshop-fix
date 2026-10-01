import { app } from "../../../scripts/app.js";
import { connect, msg } from "./connection.js";
import { brandStyle } from "./utils.js";

export const pluginNodes = new Set();
export let isPsConnected = false;
export let isWorkflowLoaded = false;
export let BluePixelExist = false;

const e = {
  listeners: new Map(),
  on(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(callback);
  },
  off(name, callback) { this.listeners.get(name)?.delete(callback); },
  emit(name, ...args) {
    return Promise.all([...this.listeners.get(name) || []].map(async callback => {
      try { await callback(...args); }
      catch (error) { console.error(`🔹 ${name}:`, error); }
    }));
  }
};

app.registerExtension({
  name: "🔹BluePixel.V3",
  init() { return e.emit("init"); },
  setup() { return e.emit("setup"); },
  onProgressUpdate(event) { return e.emit("onProgressUpdate", event); },
  beforeRegisterNodeDef(nodeType, nodeData) {
    return e.emit("beforeRegister", nodeType, nodeData, app);
  },
  beforeConfigureGraph(data) {
    isWorkflowLoaded = false;
    return e.emit("beforeConfigureGraph", data);
  },
  async afterConfigureGraph(data) {
    await e.emit("workflowLoaded", data);
    isWorkflowLoaded = true;
    await e.emit("afterWorkflowLoaded", data);
  },
  nodeCreated(node) {
    if (node.comfyClass?.startsWith("🔹")) {
      brandStyle(node);
      const onAdded = node.onAdded;
      node.onAdded = function (...args) {
        const result = onAdded?.apply(this, args);
        pluginNodes.add(this);
        BluePixelExist = true;
        connect();
        e.emit("slotsChanged", this);
        return result;
      };
      const onRemoved = node.onRemoved;
      node.onRemoved = function (...args) {
        const result = onRemoved?.apply(this, args);
        pluginNodes.delete(this);
        BluePixelExist = pluginNodes.size > 0;
        e.emit("slotsChanged", this);
        return result;
      };
      const onModeChanged = node.onModeChanged;
      node.onModeChanged = function (...args) {
        const result = onModeChanged?.apply(this, args);
        e.emit("slotsChanged", this);
        return result;
      };
    }
    return e.emit("nodeCreated", node);
  }
});

msg("psConnected", () => {
  isPsConnected = true;
  return e.emit("psConnected");
});

export default e;

e.on("setup", () => {
  const metadata = new WeakMap();
  const timer = setInterval(() => {
    if (!isWorkflowLoaded) return;
    for (const node of pluginNodes) {
      const previous = metadata.get(node);
      metadata.set(node, {title: node.title, mode: node.mode});
      if (previous && previous.title !== node.title) node.onTitleChanged?.(node.title);
      if (previous && previous.mode !== node.mode) e.emit("slotsChanged", node);
    }
  }, 500);
  window.addEventListener("pagehide", () => clearInterval(timer), {once: true});
});
