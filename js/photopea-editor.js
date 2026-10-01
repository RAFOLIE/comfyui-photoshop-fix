import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const origin = "https://www.photopea.com";
let editor;
async function editImage(node) {
  const source = node.imgs?.[0]?.src;
  if (!source) return;
  editor?.close();
  editor = document.createElement("dialog");
  editor.className = "ps-photopea-editor";
  const iframe = document.createElement("iframe");
  iframe.src = origin + "/";
  iframe.title = "Photopea 图像编辑器";
  const footer = document.createElement("div");
  const button = (text, callback) => {
    const element = document.createElement("button");
    element.textContent = text;
    element.addEventListener("click", callback);
    footer.append(element);
    return element;
  };
  let pending;
  const receive = event => {
    if (event.origin !== origin || event.source !== iframe.contentWindow || !pending) return;
    if (event.data instanceof ArrayBuffer) pending.data = event.data;
    if (event.data === "done") {
      clearTimeout(pending.timer);
      pending.resolve(pending.data);
      pending = undefined;
    }
  };
  window.addEventListener("message", receive);
  const command = script => new Promise((resolve, reject) => {
    if (pending) return reject(new Error("Photopea 正忙，请稍后再试。"));
    pending = {resolve, reject, timer: setTimeout(() => {
      pending = undefined;
      reject(new Error("Photopea 未响应，请稍后重试。"));
    }, 30000)};
    iframe.contentWindow.postMessage(script, origin);
  });
  const save = async selection => {
    try {
      const script = selection
        ? 'var doc=app.activeDocument;doc.flatten();doc.selection.invert();doc.selection.clear();app.activeDocument.saveToOE("png");'
        : 'app.activeDocument.saveToOE("png");';
      const data = await command(script);
      if (!data) throw new Error("Photopea 未返回图像。");
      const form = new FormData();
      form.append("image", new Blob([data], {type:"image/png"}), "photopea-" + Date.now() + ".png");
      form.append("subfolder", "ComfyUI-Photoshop");
      const response = await api.fetchApi("/upload/image", {method:"POST", body:form});
      if (!response.ok) throw new Error("图像上传失败：" + response.status);
      const result = await response.json();
      const target = node.widgets?.some(widget => widget.name === "image") ? node : LiteGraph.createNode("LoadImage");
      if (target !== node) {
        (node.graph || app.graph).add(target);
        target.pos = [node.pos[0] + node.size[0] + 40, node.pos[1]];
      }
      const widget = target.widgets.find(widget => widget.name === "image");
      widget.value = (result.subfolder ? result.subfolder + "/" : "") + result.name;
      widget.callback?.(widget.value);
      editor.close();
    } catch (error) { window.alert(error.message); }
  };
  button("将选区保存为遮罩", () => save(true));
  button("保存", () => save(false));
  button("全屏", () => editor.classList.toggle("ps-photopea-fullscreen"));
  button("取消", () => editor.close());
  editor.append(iframe, footer);
  document.body.append(editor);
  editor.addEventListener("close", () => {
    window.removeEventListener("message", receive);
    if (pending) { clearTimeout(pending.timer); pending.reject(new Error("Editor closed.")); pending = undefined; }
    editor.remove();
  }, {once:true});
  iframe.addEventListener("load", async () => {
    try {
      const response = await fetch(source);
      const blob = await response.blob();
      const reader = new FileReader();
      reader.addEventListener("load", () => command("app.open(" + JSON.stringify(reader.result) + ",null,false);").catch(console.error));
      reader.readAsDataURL(blob);
    } catch (error) { console.error("Photopea image load:", error); }
  }, {once:true});
  editor.showModal();
}

app.registerExtension({
  name: "🔹Photoshop.Photopea",
  beforeRegisterNodeDef(nodeType, nodeInfo) {
    if (!nodeInfo.output?.includes("IMAGE") && !nodeInfo.output?.includes("MASK") && !nodeInfo.output_node) return;
    const original = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function (_, menuOptions) {
      const result = original?.apply(this, arguments);
      menuOptions.push({content:"🔹 Photopea 图像编辑器", disabled:!this.imgs?.length, callback:() => editImage(this)});
      return result;
    };
  },
});
