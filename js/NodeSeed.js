import { AddHtmlWidget } from "./utils.js";
import { msg, sendMsg, sendMsgImmediate } from "./connection.js";
import { nodesOf, widgetOf, setWidgetValue, watchWidget, onConfigure } from "./slots.js";
import e, { isPsConnected, isWorkflowLoaded } from "./event.js";
import { api } from "../../../scripts/api.js";

const NodeID = "🔹SeedManager";
const refreshers = new WeakMap();
const randomSeed = () => Math.floor(Math.random() * 999999) + 1;
const state = node => ({
  seed: Number(widgetOf(node, "manual_seed").value),
  autorandom: widgetOf(node, "random_seed").value,
});
function synchronize(seed, autorandom) {
  seed = Math.max(0, Math.min(999999, Math.trunc(Number(seed))));
  if (!Number.isFinite(seed)) return;
  autorandom = autorandom === true || autorandom === "enable" ? "enable" : "disable";
  for (const node of nodesOf(NodeID)) {
    setWidgetValue(node, "manual_seed", seed);
    setWidgetValue(node, "random_seed", autorandom);
    refreshers.get(node)?.();
  }
}
function send(immediate = false) {
  const node = nodesOf(NodeID)[0];
  if (node && isPsConnected && isWorkflowLoaded) {
    return (immediate ? sendMsgImmediate : sendMsg)("SeedSlot", state(node));
  }
}

e.on("nodeCreated", node => {
  if (node.comfyClass !== NodeID) return;
  const update = () => { const {seed, autorandom} = state(node); synchronize(seed, autorandom); send(true); };
  watchWidget(node, "manual_seed", update);
  watchWidget(node, "random_seed", update);
  const row = document.createElement("div");
  row.className = "ps-v3-seed";
  row.innerHTML = '<span>随机种子</span><div class="ps-v3-seed-controls"><button type="button" aria-label="减小种子">−</button><input type="number" min="0" max="999999" step="1" aria-label="种子数值"><button type="button" class="ps-v3-seed-toggle" aria-label="自动随机种子" aria-pressed="false">⤨</button><button type="button" aria-label="增大种子">+</button></div>';
  const input = row.querySelector("input");
  const [minus, toggle, plus] = row.querySelectorAll("button");
  const refresh = () => {
    const {seed, autorandom} = state(node);
    input.value = seed;
    const enabled = autorandom === "enable";
    toggle.setAttribute("aria-pressed", String(enabled));
    toggle.title = enabled ? "自动随机已启用：运行时生成新种子（与 PS 同步）" : "自动随机已关闭：保持当前种子（与 PS 同步）";
  };
  const setSeed = value => {
    synchronize(value, state(node).autorandom);
    send(true);
    refresh();
  };
  input.addEventListener("change", () => {
    if (input.value === "" || !Number.isFinite(input.valueAsNumber)) return refresh();
    setSeed(input.valueAsNumber);
  });
  minus.addEventListener("click", () => setSeed(state(node).seed - 1));
  plus.addEventListener("click", () => setSeed(state(node).seed + 1));
  toggle.addEventListener("click", () => {
    synchronize(state(node).seed, state(node).autorandom === "enable" ? "disable" : "enable");
    send(true);
    refresh();
  });
  refreshers.set(node, refresh);
  // Keep the serialized widgets and PS protocol; only replace their presentation.
  const hideOriginalControls = () => {
    for (const name of ["manual_seed", "random_seed"]) {
      const widget = widgetOf(node, name);
      widget.hidden = true;
      widget.options.hidden = true;
    }
    refresh();
  };
  AddHtmlWidget(node, "seed_control", row, 36);
  onConfigure(node, hideOriginalControls);
  hideOriginalControls();
  const onAdded = node.onAdded;
  node.onAdded = function (...args) {
    const peer = nodesOf(NodeID).find(peer => peer !== this);
    if (peer && isWorkflowLoaded) {
      const {seed, autorandom} = state(peer);
      setWidgetValue(this, "manual_seed", seed);
      setWidgetValue(this, "random_seed", autorandom);
      refresh();
    }
    return onAdded?.apply(this, args);
  };
});

msg("SeedSlot", data => synchronize(data.seed, data.autorandom));
e.on("afterWorkflowLoaded", () => {
  const node = nodesOf(NodeID)[0];
  if (node) { const {seed, autorandom} = state(node); synchronize(seed, autorandom); }
});
for (const event of ["slotsChanged", "afterWorkflowLoaded", "psConnected"]) e.on(event, () => send());

const queuePrompt = api.queuePrompt.bind(api);
api.queuePrompt = async function (index, prompt, ...args) {
  const node = nodesOf(NodeID)[0];
  if (node && state(node).autorandom === "enable") {
    const seed = randomSeed();
    synchronize(seed, "enable");
    for (const value of Object.values(prompt.output)) {
      if (value.class_type === NodeID) value.inputs.manual_seed = seed;
    }
    for (const value of prompt.workflow?.nodes || []) {
      if (value.type === NodeID && value.widgets_values) value.widgets_values[0] = seed;
    }
    await send(true);
  }
  return queuePrompt(index, prompt, ...args);
};
