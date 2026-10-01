import { app as app } from "../../../scripts/app.js";
import { api as api } from "../../../scripts/api.js";
import { sendMsg, sendMsgImmediate, msg } from "./connection.js";
import e, { BluePixelExist } from "./event.js";
import { switcherWidgets, switcherState, setSwitcherState } from "./switcher.js";

export const nodever = "2.0.49-v3-preview.2";

// ==================== 工作流同步系统 ====================
let workflowSwitcher = null;
let rndrModeSwitcher = null;
let workflowInterval = null;
let rndrInterval = null;

/**
 * 获取节点的安全颜色值
 */
function getSafeColor(node) {
  if (!node) return "";
  if (node.properties) {
    if (node.properties["Color"]) return node.properties["Color"].toLowerCase();
    if (node.properties["color"]) return node.properties["color"].toLowerCase();
  }
  return (node.color || node.bgcolor || "").toLowerCase();
}

/**
 * 识别 rgthree Fast Groups Muter 节点
 * 根据颜色和标题来区分工作流切换器和渲染模式切换器
 */
function identifyNode(node) {
  if (node.comfyClass !== "Fast Groups Muter (rgthree)") return;

  const nodeTitle = (node.title || "").trim();
  const c = getSafeColor(node) || "#000";

  // 绿色系 - 渲染模式切换器
  const isGreen =
    c === "#223322" || c === "#232" ||
    c === "#4e5e4e" ||
    c === "#332222" || c === "#322" ||
    c === "#332922";

  // 蓝色系 - 工作流切换器
  const isBlue =
    c === "#222233" || c === "#223" ||
    c === "#2a363b" ||
    c === "#2b4557" ||
    c === "#223333" || c === "#233" ||
    c === "#332233" || c === "#323" ||
    c === "#443322" || c === "#432" ||
    c === "#000" ||
    c === "#222222" || c === "#222";

  if (!workflowSwitcher) {
    if (nodeTitle.startsWith("📁") || isBlue) {
      workflowSwitcher = node;
      console.log(`🔹 [PS Plugin] Workflow Switcher Found! ID: ${node.id}, Color: ${c}`);
      startWorkflowChecker();
    }
  }

  if (!rndrModeSwitcher) {
    if (nodeTitle.startsWith("⚙️") || isGreen) {
      rndrModeSwitcher = node;
      console.log(`🔹 [PS Plugin] Render Mode Switcher Found! ID: ${node.id}, Color: ${c}`);
      startRenderChecker();
    }
  }
}

/**
 * 扫描所有节点以查找切换器
 */
function scanForSwitchers() {
  if (!app.graph) return;
  const nodes = app.graph._nodes;
  if (nodes && nodes.length > 0) {
    nodes.forEach(node => identifyNode(node));
  }
}

/**
 * 处理切换器点击 - 修复 render 三角按钮不工作的问题
 */
function handleSwitcherClick(targetIndex, switcherNode) {
  try {
    const targetIdx = parseInt(targetIndex);
    if (!switcherNode || !switcherNode.widgets) {
      console.error("🔹 Switcher node not found.");
      return;
    }

    const widgets = switcherWidgets(switcherNode);
    widgets.forEach((widget, index) => {
      const shouldBeOn = (index === targetIdx);
      if (switcherState(widget) !== shouldBeOn || shouldBeOn) {
        setSwitcherState(widget, shouldBeOn);
        if (switcherNode.onWidgetChanged) {
          switcherNode.onWidgetChanged(widget.name, widget.value, null, widget);
        }
      }
    });

    // 强制刷新画布
    switcherNode.setDirtyCanvas(true, true);
    app.graph.setDirtyCanvas(true, true);
    if (switcherNode.onResize) switcherNode.onResize(switcherNode.size);

  } catch (error) {
    console.error("🔹 Error in handleSwitcherClick:", error);
  }
}

/**
 * 获取切换器的 widget 名称和状态
 */
function getSwitcherWidgetNames(switcher) {
  try {
    let widgetNames = [];
    let widgets = switcherWidgets(switcher);

    if (!widgets) return widgetNames;

    widgets.forEach((widget) => {
      const isEnabled = switcherState(widget);
      const displayName = String(widget.label || widget.name || "Unknown").replace(/^Enable |^Disable /, "");

      if (isEnabled) {
        widgetNames.push({ name: displayName, selected: true });
      } else {
        widgetNames.push({ name: displayName });
      }
    });
    return widgetNames;
  } catch (error) {
    console.error("🔹 Error in getSwitcherWidgetNames:", error);
    return [];
  }
}

/**
 * 启动工作流切换器状态检查器
 */
function startWorkflowChecker() {
  if (workflowInterval) clearInterval(workflowInterval);
  if (!workflowSwitcher) return;

  const getWidgetStates = (node) => {
    return JSON.stringify(switcherWidgets(node).map(w => ({
      name: w.name,
      label: w.label,
      value: switcherState(w)
    })));
  };
  let previousWorkflowWidgets = getWidgetStates(workflowSwitcher);

  workflowInterval = setInterval(() => {
    try {
      if (!workflowSwitcher) { clearInterval(workflowInterval); return; }
      const currentWorkflowWidgets = getWidgetStates(workflowSwitcher);
      if (currentWorkflowWidgets !== previousWorkflowWidgets) {
        console.log("🔹 Workflow switcher widgets have changed");
        sendMsg("Send_workflow", getSwitcherWidgetNames(workflowSwitcher));
        previousWorkflowWidgets = currentWorkflowWidgets;
      }
    } catch (error) {
      console.error("🔹 Error in workflow checker:", error);
    }
  }, 3000);
}

/**
 * 启动渲染模式切换器状态检查器
 */
function startRenderChecker() {
  if (rndrInterval) clearInterval(rndrInterval);
  if (!rndrModeSwitcher) return;

  const getWidgetStates = (node) => {
    return JSON.stringify(switcherWidgets(node).map(w => ({
      name: w.name,
      label: w.label,
      value: switcherState(w)
    })));
  };
  let previousRndrModeWidgets = getWidgetStates(rndrModeSwitcher);

  rndrInterval = setInterval(() => {
    try {
      if (!rndrModeSwitcher) { clearInterval(rndrInterval); return; }
      const currentRndrModeWidgets = getWidgetStates(rndrModeSwitcher);
      if (currentRndrModeWidgets !== previousRndrModeWidgets) {
        console.log("🔹 Render mode switcher widgets have changed");
        sendMsg("Send_rndrMode", getSwitcherWidgetNames(rndrModeSwitcher));
        previousRndrModeWidgets = currentRndrModeWidgets;
      }
    } catch (error) {
      console.error("🔹 Error in render mode checker:", error);
    }
  }, 3000);
}

// ==================== 消息监听器 ====================
msg("alert", (data) => {
  try {
    alert(data);
  } catch (error) {
    console.error("🔹 Error in alert listener:", error);
  }
});

msg("queue", (data) => {
  try {
    if (!isProcessing) {
      if (BluePixelExist) {
        isProcessing = true;
        (function processQueue() {
          if (genrateStatus !== "genrating") {
            app.queuePrompt();
            isProcessing = false;
          } else {
            setTimeout(processQueue, 100);
          }
        })();
      } else {
        console.log("🔹 Photoshop Node doesn't Exist");
      }
    }
  } catch (error) {
    console.error("🔹 Error in queue listener:", error);
  }
});

// 工作流切换消息监听
msg("workflow", (data) => {
  try {
    console.log("🔹 Received workflow selection index:", data);
    handleSwitcherClick(data, workflowSwitcher);
  } catch (error) {
    console.error("🔹 Error in workflow listener:", error);
  }
});

// 渲染模式切换消息监听
msg("rndrMode", (data) => {
  try {
    console.log("🔹 Received rndrMode selection index:", data);
    handleSwitcherClick(data, rndrModeSwitcher);
  } catch (error) {
    console.error("🔹 Error in rndrMode listener:", error);
  }
});

// PS 连接时同步工作流状态
e.on("psConnected", () => {
  try {
    console.log("🔹 PS Connected - syncing workflow state");
    if (workflowSwitcher) sendMsg("Send_workflow", getSwitcherWidgetNames(workflowSwitcher));
    if (rndrModeSwitcher) sendMsg("Send_rndrMode", getSwitcherWidgetNames(rndrModeSwitcher));
  } catch (error) {
    console.error("🔹 Error syncing on PS connect:", error);
  }
});

// 初始化时扫描切换器
e.on("beforeConfigureGraph", () => {
  clearInterval(workflowInterval);
  clearInterval(rndrInterval);
  workflowSwitcher = null;
  rndrModeSwitcher = null;
});
e.on("afterWorkflowLoaded", () => {
  setTimeout(() => scanForSwitchers(), 1000);
  setTimeout(() => scanForSwitchers(), 3000);
});

async function getWorkflow(name) {
  try {
    console.log("name: ", name);
    const response = await api.fetchApi(`/ps/workflows/${encodeURIComponent(name)}`, { cache: "no-store" });
    return await response.json();
  } catch (error) {
    console.error("🔹 Error in getWorkflow:", error);
  }
}

export async function loadWorkflow(workflowName) {
  const supportedLocales = ["ja-JP", "ko-KR", "zh-TW", "zh-CN"];
  let currentLocale = localStorage.getItem("AGL.Locale");

  if (!supportedLocales.includes(currentLocale)) {
    currentLocale = "en-US";
  }

  console.log("🔹 Load workflow for this language:", currentLocale);
  workflowName = workflowName + "_" + currentLocale;
  try {
    const workflowData = await getWorkflow(workflowName);
    app.loadGraphData(workflowData);
  } catch (error) {
    console.error(`Failed to load workflow ${workflowName}:`, error);
    alert(`Failed to load workflow ${workflowName}`);
  }
}

let genrateStatus = "genrated";
let isProcessing = false;

api.addEventListener("execution_start", ({ detail }) => {
  try {
    genrateStatus = "genrating";
    // Send immediately so PS knows rendering started right away
    sendMsgImmediate("render_status", "genrating");
  } catch (error) {
    console.error("🔹 Error in execution_start listener:", error);
  }
});
api.addEventListener("executing", ({ detail }) => {
  try {
    if (!detail || detail.node === null) {
      genrateStatus = "genrated";
      isProcessing = false;
      // Send immediately so PS knows rendering finished right away
      sendMsgImmediate("render_status", "genrated");
    }
  } catch (error) {
    console.error("🔹 Error in executing listener:", error);
  }
});
api.addEventListener("execution_error", ({ detail }) => {
  try {
    genrateStatus = "genrate_error";
    isProcessing = false;
    // Send immediately so PS knows about error right away
    sendMsgImmediate("render_status", "genrate_error");
  } catch (error) {
    console.error("🔹 Error in execution_error listener:", error);
  }
});
api.addEventListener("progress", ({ detail: { value, max } }) => {
  try {
    let progress = Math.floor((value / max) * 100);
    if (!isNaN(progress) && progress >= 0 && progress <= 100) {
      sendMsg("progress", progress);
    }
  } catch (error) {
    console.error("🔹 Error in progress listener:", error);
  }
});

export function appendMenuOption(nodeType, callbackFn) {
  const originalMenuOptions = nodeType.prototype.getExtraMenuOptions;
  nodeType.prototype.getExtraMenuOptions = function () {
    const options = originalMenuOptions?.apply(this, arguments);
    callbackFn.apply(this, arguments);
    return options;
  };
}
