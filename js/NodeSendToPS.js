import e from "./event.js";
import { clinetid } from "./connection.js";
import { widgetOf, onConfigure } from "./slots.js";

e.on("nodeCreated", node => {
  if (node.comfyClass !== "🔹SendTo Photoshop Plugin") return;
  const widget = widgetOf(node, "cmUID");
  if (!widget) return;
  widget.value = clinetid;
  widget.serializeValue = () => clinetid;
  onConfigure(node, () => { widget.value = clinetid; });
});
