import { manageNameList, getTitleInfoMap } from "./TitleManager.js";
import { AddHtmlWidget, sendList } from "./utils.js";
import { nodesOf, widgetOf, setWidgetValue, watchWidget, onConfigure } from "./slots.js";
import { api } from "../../../scripts/api.js";
import e from "./event.js";

const NodeID = "🔹Photoshop Images";
const previews = new WeakMap();
const send = async () => sendList("ImageSlots", await getTitleInfoMap("ImageSlots"), "MAIN DOC");

e.on("nodeCreated", node => {
  if (node.comfyClass !== NodeID) return;
  const refreshTitle = manageNameList(node, "ImageSlots", ["MAIN DOC"]);
  const element = document.createElement("div");
  element.classList.add("ps-v3-preview");
  const image = document.createElement("img");
  image.alt = "Photoshop 图像预览";
  const selection = document.createElement("img");
  selection.alt = "Photoshop 选区预览";
  selection.classList.add("ps-v3-selection");
  selection.hidden = true;
  const empty = document.createElement("span");
  empty.textContent = "等待 Photoshop 传入图像";
  element.append(image, selection, empty);
  const previewWidget = AddHtmlWidget(node, "image_preview", element, 160);
  // Give extra node height to the preview, keeping the controls above compact.
  delete previewWidget.options.getMaxHeight;
  let imageUrl;
  let selectionUrl;
  let revision = 0;
  const preview = async () => {
    const current = ++revision;
    image.hidden = true;
    selection.hidden = true;
    empty.hidden = false;
    if (node.properties?.["Disable Preview"]) return;
    // The inventory avoids expected 404s while Photoshop has not uploaded a canvas.
    const response = await api.fetchApi("/ps/input_images", {cache: "no-store"});
    if (!response.ok) return;
    const filenames = await response.json();
    const name = widgetOf(node, "ImageName").value;
    const candidates = [name + ".png", name + ".jpg", name + ".jpeg"];
    const filename = filenames.find(file => candidates.includes(file));
    if (!filename || current !== revision) return;
    const result = await api.fetchApi("/ps/inputs/" + encodeURIComponent(filename), {cache: "no-store"});
    if (!result.ok) return;
    const blob = await result.blob();
    if (current !== revision) return;
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    imageUrl = URL.createObjectURL(blob);
    image.src = imageUrl;
    image.hidden = false;
    empty.hidden = true;
    if (name === "MAIN DOC" && filenames.includes("SELECTION.png")) {
      const mask = await api.fetchApi("/ps/inputs/SELECTION.png", {cache: "no-store"});
      if (mask.ok) {
        const maskBlob = await mask.blob();
        if (current !== revision) return;
        if (selectionUrl) URL.revokeObjectURL(selectionUrl);
        selectionUrl = URL.createObjectURL(maskBlob);
        selection.src = selectionUrl;
        selection.hidden = false;
      }
    }
  };
  previews.set(node, preview);
  const onTitleChanged = node.onTitleChanged;
  node.onTitleChanged = function (...args) {
    setWidgetValue(this, "ImageName", this.title);
    const result = onTitleChanged?.apply(this, args);
    preview().catch(console.error);
    return result;
  };
  watchWidget(node, "ImageName", value => {
    node.title = String(value);
    node.onTitleChanged?.(node.title);
  });
  onConfigure(node, () => {
    setWidgetValue(node, "ImageName", node.title);
    refreshTitle();
    preview().catch(console.error);
  });
  const onRemoved = node.onRemoved;
  node.onRemoved = function (...args) {
    revision++;
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    if (selectionUrl) URL.revokeObjectURL(selectionUrl);
    return onRemoved?.apply(this, args);
  };
});

api.addEventListener("execution_start", () => {
  for (const node of nodesOf(NodeID)) previews.get(node)?.().catch(console.error);
});
for (const event of ["slotsChanged", "afterWorkflowLoaded", "psConnected"]) {
  e.on(event, async () => {
    await send();
    for (const node of nodesOf(NodeID)) await previews.get(node)?.();
  });
}
