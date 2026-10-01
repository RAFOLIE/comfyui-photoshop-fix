import { pluginNodes, isWorkflowLoaded } from "./event.js";

const updating = new WeakSet();

export const nodesOf = type => [...pluginNodes].filter(node => node.comfyClass === type);
export const widgetOf = (node, name) => node.widgets?.find(widget => widget.name === name);

export function setWidgetValue(node, name, value) {
  const widget = widgetOf(node, name);
  if (!widget || widget.value === value) return;
  updating.add(widget);
  try { widget.value = value; }
  finally { updating.delete(widget); }
}

export function watchWidget(node, name, onChange) {
  const widget = widgetOf(node, name);
  if (!widget) return;
  const callback = widget.callback;
  widget.callback = function (value, ...args) {
    const result = callback?.call(this, value, ...args);
    if (!updating.has(widget) && isWorkflowLoaded) onChange(value);
    return result;
  };
}

export function onConfigure(node, callback) {
  const original = node.onConfigure;
  node.onConfigure = function (...args) {
    const result = original?.apply(this, args);
    callback();
    return result;
  };
}

export function groups(type) {
  const result = new Map();
  for (const node of nodesOf(type)) {
    if (!result.has(node.title)) result.set(node.title, []);
    result.get(node.title).push(node);
  }
  return [...result].map(([title, nodes]) => ({title, nodes, ids: nodes.map(node => node.id)}));
}
