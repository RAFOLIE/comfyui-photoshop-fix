import { sendList, sendListImmediate } from "./utils.js";
import { msg } from "./connection.js";
import { manageNameList } from "./TitleManager.js";
import { nodesOf, widgetOf, setWidgetValue, watchWidget, groups, onConfigure } from "./slots.js";
import e, { isWorkflowLoaded } from "./event.js";

const NodeID = "🔹Photoshop Strings";
const msgType = "StringSlots";
const send = immediate => (immediate ? sendListImmediate : sendList)(
  msgType, groups(NodeID).map(({title, ids, nodes}) => ({
    title, ids, value: widgetOf(nodes[0], "string").value,
  })), ["+ PROMPT", "- PROMPT"]);

function synchronize(node, value) {
  for (const peer of nodesOf(NodeID).filter(peer => peer.title === node.title)) {
    setWidgetValue(peer, "string", String(value ?? ""));
  }
}

e.on("nodeCreated", node => {
  if (node.comfyClass !== NodeID) return;
  const refresh = manageNameList(node, msgType, ["+ PROMPT", "- PROMPT"]);
  const onTitleChanged = node.onTitleChanged;
  node.onTitleChanged = function (...args) {
    const peer = nodesOf(NodeID).find(peer => peer !== this && peer.title === this.title);
    if (peer && isWorkflowLoaded) synchronize(this, widgetOf(peer, "string").value);
    return onTitleChanged?.apply(this, args);
  };
  watchWidget(node, "string", value => { synchronize(node, value); send(true); });
  const onAdded = node.onAdded;
  node.onAdded = function (...args) {
    const result = onAdded?.apply(this, args);
    const peer = nodesOf(NodeID).find(peer => peer !== this && peer.title === this.title);
    if (peer && isWorkflowLoaded) synchronize(this, widgetOf(peer, "string").value);
    return result;
  };
  onConfigure(node, refresh);
});
e.on("afterWorkflowLoaded", () => {
  for (const group of groups(NodeID)) synchronize(group.nodes[0], widgetOf(group.nodes[0], "string").value);
});

msg(msgType, data => {
  const updates = typeof data === "string" ? JSON.parse(data) : data;
  for (const {title, value} of Array.isArray(updates) ? updates : [updates]) {
    const node = nodesOf(NodeID).find(node => node.title === title);
    if (node) synchronize(node, value);
  }
});
for (const event of ["slotsChanged", "afterWorkflowLoaded", "psConnected"]) e.on(event, () => send());
