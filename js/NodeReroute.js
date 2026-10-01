import e from "./event.js";
import { app } from "../../../scripts/app.js";
import { widgetOf, onConfigure } from "./slots.js";

const NodeID = "🔹Reroute - Anything Everywhere";
const dataTypes = new Set(["*"]);

app.registerExtension({
  name: NodeID,
  addCustomNodeDefs(definitions) {
    for (const definition of Object.values(definitions)) {
      for (const type of definition.output || []) {
        if (typeof type === "string") dataTypes.add(type);
      }
    }
  },
});

e.on("nodeCreated", node => {
  if (node.comfyClass !== NodeID) return;
  const widget = widgetOf(node, "I");
  widget.options.values = [...dataTypes].sort();
  const update = value => {
    node.inputs[0].type = value;
    node.outputs[0].type = value;
    node.setDirtyCanvas(true, true);
  };
  widget.callback = update;
  onConfigure(node, () => update(widget.value));
  update(widget.value);
});
