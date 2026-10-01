window.addEventListener("message", function identifyUxp(event) {
  if (event.data !== "im uxp") return;
  document.body.classList.add("ps-uxp-view");
  window.removeEventListener("message", identifyUxp);
});
