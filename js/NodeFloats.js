import { AddHtmlWidget, sendList, sendListImmediate } from "./utils.js";
import { msg } from "./connection.js";
import { manageNameList } from "./TitleManager.js";
import { nodesOf, widgetOf, setWidgetValue, watchWidget, groups, onConfigure } from "./slots.js";
import e, { isWorkflowLoaded } from "./event.js";

const NodeID = "🔹Floats";
const msgType = "FloatSlots";
const refreshers = new WeakMap();
const settings = node => ({
  min: node.properties.slidermin ?? 0,
  max: node.properties.slidermax ?? 1,
  step: node.properties.sliderstep ?? 0.01,
});
const send = immediate => (immediate ? sendListImmediate : sendList)(
  msgType, groups(NodeID).map(({title, ids, nodes}) => ({
    title, ids, value: widgetOf(nodes[0], "float_value").value, ...settings(nodes[0]),
  })), "MAIN");

function synchronize(node, value, range = settings(node)) {
  if (!Number.isFinite(Number(value))) return;
  for (const peer of nodesOf(NodeID).filter(peer => peer.title === node.title)) {
    setWidgetValue(peer, "float_value", Number(value));
    peer.properties.slidermin = range.min;
    peer.properties.slidermax = range.max;
    peer.properties.sliderstep = range.step;
    refreshers.get(peer)?.();
  }
}

e.on("nodeCreated", node => {
  if (node.comfyClass !== NodeID) return;
  const refreshTitle = manageNameList(node, msgType, ["MAIN"]);
  const onTitleChanged = node.onTitleChanged;
  node.onTitleChanged = function (...args) {
    const peer = nodesOf(NodeID).find(peer => peer !== this && peer.title === this.title);
    if (peer && isWorkflowLoaded) synchronize(this, widgetOf(peer, "float_value").value, settings(peer));
    return onTitleChanged?.apply(this, args);
  };
  const element = document.createElement("div");
  element.innerHTML = '<input type="range" aria-label="数值滑块"><div class="ps-v3-range"></div>';
  const slider = element.querySelector("input");
  const row = element.querySelector("div");
  const inputs = {};
  for (const key of ["min", "max", "step"]) {
    const label = document.createElement("label");
    const caption = {min: "最小值", max: "最大值", step: "步长"}[key];
    label.textContent = caption + " ";
    const input = document.createElement("input");
    input.type = "number";
    input.step = "any";
    input.setAttribute("aria-label", "滑块" + caption);
    label.append(input);
    row.append(label);
    inputs[key] = input;
    input.addEventListener("change", () => {
      const range = Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, Number(input.value)]));
      if (!Object.values(range).every(Number.isFinite) || range.min >= range.max || range.step <= 0) return refresh();
      synchronize(node, widgetOf(node, "float_value").value, range);
      send(true);
    });
  }
  const refresh = () => {
    const range = settings(node);
    for (const key of ["min", "max", "step"]) slider[key] = inputs[key].value = range[key];
    slider.value = widgetOf(node, "float_value").value;
  };
  refreshers.set(node, refresh);
  const onAdded = node.onAdded;
  node.onAdded = function (...args) {
    const result = onAdded?.apply(this, args);
    const peer = nodesOf(NodeID).find(peer => peer !== this && peer.title === this.title);
    if (peer && isWorkflowLoaded) synchronize(this, widgetOf(peer, "float_value").value, settings(peer));
    return result;
  };
  slider.addEventListener("input", () => { synchronize(node, Number(slider.value)); send(); });
  slider.addEventListener("change", () => send(true));
  watchWidget(node, "float_value", value => { synchronize(node, value); send(true); });
  AddHtmlWidget(node, "slider_range", element, 72);
  onConfigure(node, () => { refreshTitle(); refresh(); });
  refresh();
});
e.on("afterWorkflowLoaded", () => {
  for (const group of groups(NodeID)) synchronize(group.nodes[0], widgetOf(group.nodes[0], "float_value").value);
});

msg(msgType, data => {
  const updates = typeof data === "string" ? JSON.parse(data) : data;
  for (const update of Array.isArray(updates) ? updates : [updates]) {
    const node = nodesOf(NodeID).find(node => node.title === update.title);
    if (!node) continue;
    const range = settings(node);
    for (const key of ["min", "max", "step"]) {
      if (update[key] !== undefined && Number.isFinite(Number(update[key]))) range[key] = Number(update[key]);
    }
    if (range.min < range.max && range.step > 0) synchronize(node, update.value, range);
  }
});
for (const event of ["slotsChanged", "afterWorkflowLoaded", "psConnected"]) e.on(event, () => send());
