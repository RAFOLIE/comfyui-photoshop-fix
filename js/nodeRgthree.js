import { msg, sendMsg } from "./connection.js";
import e, { BluePixelExist, isPsConnected, isWorkflowLoaded } from "./event.js";
import { AddHtmlWidget } from "./utils.js";
import { app } from "../../../scripts/app.js";
import { switcherWidgets as toggles, switcherState as selected, setSwitcherState } from "./switcher.js";

const types = new Set(["Fast Groups Muter (rgthree)", "Fast Groups Bypasser (rgthree)", "Fast Muter (rgthree)", "Fast Bypasser (rgthree)"]);
const nameOf = widget => String(widget.label || widget.name).replace(/^Enable |^Disable /, "");
let previous = "";

function send(force = false) {
  if (!isPsConnected || !isWorkflowLoaded || !BluePixelExist) return;
  const data = (app.graph?._nodes || []).filter(node => types.has(node.comfyClass)).map(node => ({
    id: node.id, title: node.title, type: node.properties?.toggleRestriction || "default",
    widgets: toggles(node).map(widget => ({name: nameOf(widget), selected: selected(widget)})),
  }));
  const signature = JSON.stringify(data);
  if (force || signature !== previous) { previous = signature; sendMsg("switchers", data); }
}

e.on("nodeCreated", node => {
  if (!types.has(node.comfyClass)) return;
  const select = document.createElement("select");
  select.setAttribute("aria-label", "切换限制");
  for (const [value, text] of [["default", "多选"], ["max one", "最多选一项"], ["always one", "始终选一项"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    select.append(option);
  }
  select.value = node.properties.toggleRestriction || "default";
  select.addEventListener("change", () => { node.properties.toggleRestriction = select.value; send(true); });
  AddHtmlWidget(node, "ps_toggle_restriction", select);
  const onConfigure = node.onConfigure;
  node.onConfigure = function (...args) {
    const result = onConfigure?.apply(this, args);
    select.value = this.properties.toggleRestriction || "default";
    return result;
  };
});

// Observe third-party controls without redefining their reactive values or widget arrays.
e.on("setup", () => {
  const timer = setInterval(() => send(), 500);
  window.addEventListener("pagehide", () => clearInterval(timer), {once: true});
});
e.on("psConnected", () => send(true));
e.on("afterWorkflowLoaded", () => send(true));

msg("switchers", ({switcherId, widgets}) => {
  const node = app.graph.getNodeById(switcherId);
  if (!node) return;
  for (const received of widgets) {
    const widget = toggles(node).find(widget => nameOf(widget) === received.name);
    if (!widget || selected(widget) === received.selected) continue;
    setSwitcherState(widget, received.selected);
  }
  send(true);
});
