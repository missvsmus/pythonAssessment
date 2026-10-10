/*
 * Browser-side Python runner for the coding assessment.
 * Pyodide is loaded from jsDelivr and executes inside a dedicated Web Worker,
 * so student code does not run on the page's main UI thread.
 */
let pyodideInstance = null;
let outputParts = [];
let errorParts = [];
let busy = false;

self.postMessage({ type: "status", message: "Loading Python runtime… the first run can take a little while." });

async function initializePython() {
  if (pyodideInstance) return;
  importScripts("https://cdn.jsdelivr.net/pyodide/v0.27.7/full/pyodide.js");
  pyodideInstance = await loadPyodide();
  pyodideInstance.setStdout({ batched: text => outputParts.push(text) });
  pyodideInstance.setStderr({ batched: text => errorParts.push(text) });
  self.postMessage({ type: "ready" });
}

self.onmessage = async (event) => {
  const message = event.data || {};
  if (message.type !== "run" || busy) return;
  busy = true;
  outputParts = [];
  errorParts = [];
  self.postMessage({ type: "running" });

  try {
    await initializePython();
    // Give each run a fresh global namespace so variables from previous runs
    // do not accidentally affect the current attempt.
    const globals = pyodideInstance.runPython("dict(__name__='__main__', __builtins__=__builtins__)");
    try {
      await pyodideInstance.runPythonAsync(String(message.code || ""), { globals });
    } finally {
      globals.destroy();
    }

    const output = outputParts.join("") + errorParts.join("");
    self.postMessage({ type: "result", output });
  } catch (error) {
    const output = outputParts.join("");
    const stderr = errorParts.join("");
    self.postMessage({
      type: "error",
      output: [output, stderr].filter(Boolean).join(""),
      error: error && error.message ? error.message : String(error)
    });
  } finally {
    busy = false;
  }
};

initializePython().catch(error => {
  self.postMessage({
    type: "error",
    output: "",
    error: "Python could not load: " + (error && error.message ? error.message : String(error))
  });
});
