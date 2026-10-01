export const isSwitcherWidget = widget =>
  widget.type === "RGTHREE_TOGGLE_AND_NAV" ||
  typeof widget.toggled === "boolean" || typeof widget.toggle === "boolean" ||
  typeof widget.value === "boolean" ||
  (widget.value && typeof widget.value === "object" && "toggled" in widget.value);

export const switcherWidgets = node => (node.widgets || []).filter(isSwitcherWidget);

export function switcherState(widget) {
  if (typeof widget.toggled === "boolean") return widget.toggled;
  if (widget.value && typeof widget.value === "object") return !!widget.value.toggled;
  if (typeof widget.toggle === "boolean") return widget.toggle;
  return !!widget.value;
}

export function setSwitcherState(widget, selected) {
  selected = !!selected;
  if (typeof widget.doModeChange === "function") {
    widget.doModeChange(selected, true);
    return;
  }
  if (typeof widget.toggled === "boolean") widget.toggled = selected;
  else if (widget.value && typeof widget.value === "object") widget.value.toggled = selected;
  else if (typeof widget.toggle === "boolean") widget.toggle = selected;
  else widget.value = selected;
  widget.callback?.(widget.value);
}
