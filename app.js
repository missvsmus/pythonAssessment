let state = {
  role: null,
  student: null,
  question: null,
  teacherStudents: [],
  selectedStudent: null
};

// Keep the student's access code in memory while this page is open so the
// page can check for a teacher-assigned question without requiring re-login.
let studentAccessCode = "";
let studentPollTimer = null;
let pythonWorker = null;
let pythonWorkerReady = false;
let pythonPendingRun = null;
let pythonRunTimer = null;
let pythonLoadTimer = null;
let pythonRunId = 0;

const $ = id => document.getElementById(id);

function show(id) {
  document.querySelectorAll("main > section").forEach(s => s.classList.add("hidden"));
  $(id).classList.remove("hidden");
}

async function api(action, data = {}) {
  if (!API_URL || API_URL.includes("PASTE_YOUR")) {
    throw new Error("Google Apps Script URL has not been configured yet.");
  }

  const response = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ action, ...data })
  });

  const result = await response.json();

  if (!result.ok) {
    throw new Error(result.error || "The server returned an error.");
  }

  return result;
}

$("login-btn").addEventListener("click", login);
$("access-code").addEventListener("keydown", e => {
  if (e.key === "Enter") login();
});


// Capture Tab before the browser can move focus to the Run/Test button.
// Use a document-level capture listener so it still works if other listeners
// are added to the editor later.
document.addEventListener("keydown", e => {
  const editor = e.target;
  if (editor?.id !== "code-editor" || e.key !== "Tab") return;

  e.preventDefault();
  e.stopPropagation();

  const value = editor.value;
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const indent = "    ";

  if (e.shiftKey) {
    const lineStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
    const lineEndIndex = value.indexOf("\n", start);
    const lineEnd = lineEndIndex === -1 ? value.length : lineEndIndex;
    const line = value.slice(lineStart, lineEnd);
    let removeCount = 0;
    if (line.startsWith(indent)) removeCount = indent.length;
    else if (line.startsWith(" ")) removeCount = 1;
    else if (line.startsWith("\t")) removeCount = 1;
    if (removeCount) {
      editor.value = value.slice(0, lineStart) + value.slice(lineStart + removeCount);
      editor.setSelectionRange(Math.max(lineStart, start - removeCount), Math.max(lineStart, end - removeCount));
    }
    editor.focus();
    return;
  }

  // Indent each line if the selection spans multiple lines.
  if (value.slice(start, end).includes("\n")) {
    const lineStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
    const endLineBreak = value.indexOf("\n", end);
    const lineEnd = endLineBreak === -1 ? value.length : endLineBreak;
    const selected = value.slice(lineStart, lineEnd);
    const lines = selected.split("\n").map(line => indent + line).join("\n");
    editor.value = value.slice(0, lineStart) + lines + value.slice(lineEnd);
    const lineCount = selected.split("\n").length;
    editor.setSelectionRange(start + indent.length, end + indent.length * lineCount);
  } else {
    editor.value = value.slice(0, start) + indent + value.slice(end);
    const cursor = start + indent.length;
    editor.setSelectionRange(cursor, cursor);
  }
  editor.focus();
}, true);

$("logout-btn").addEventListener("click", () => {
  if (studentPollTimer) clearTimeout(studentPollTimer);
  studentPollTimer = null;
  studentAccessCode = "";
  state = { role: null, student: null, question: null, teacherStudents: [], selectedStudent: null };
  localStorage.removeItem("assessmentSession");
  localStorage.removeItem("assessmentTeacherToken");
  $("student-status").textContent = "";
  $("logout-btn").classList.add("hidden");
  show("login-screen");
});

async function login() {
  const code = $("access-code").value.trim();
  $("login-error").textContent = "";

  if (!code) {
    $("login-error").textContent = "Please enter your access code.";
    return;
  }

  $("login-btn").disabled = true;

  try {
    const result = await api("login", { code });

    if (result.role === "teacher") {
      state.role = "teacher";
      localStorage.setItem("assessmentTeacherToken", result.teacherToken);
      $("logout-btn").classList.remove("hidden");
      await loadTeacherDashboard();
    } else {
      state.role = "student";
      state.student = result.student;
      state.question = result.question;
      studentAccessCode = code;

      if (result.sessionToken) {
        localStorage.setItem("assessmentSession", result.sessionToken);
      } else {
        localStorage.removeItem("assessmentSession");
      }

      $("student-status").textContent = result.student.name;
      $("logout-btn").classList.remove("hidden");

      if (!result.question) {
        $("locked-message").textContent = result.waiting
          ? "Your answer has been submitted. Your teacher will give you your next question."
          : "Your assessment has been completed. You can now logout.";
        show("locked-screen");
        if (result.waiting) startStudentPolling();
      } else {
        renderStudent();
      }
    }
  } catch (err) {
    $("login-error").textContent = err.message;
  } finally {
    $("login-btn").disabled = false;
  }
}

function renderStudent() {
  if (!state.question) {
    show("locked-screen");
    return;
  }

  show("student-screen");

  //$("question-label").textContent = `Question ${state.question.id}`;
  $("assessment-status").textContent =
    state.question.submitted ? "Submitted" : "In progress";

  $("question-title").textContent =
    state.question.title || `Question ${state.question.id}`;

  $("question-text").textContent = state.question.text || "";

  if (state.question.starterText) {
    $("starter-info").classList.remove("hidden");
    $("starter-text").textContent = state.question.starterText;
  } else {
    $("starter-info").classList.add("hidden");
  }

  $("code-editor").value = state.question.starterCode || "";
  $("code-editor").disabled = !!state.question.submitted;
  $("submit-btn").disabled = !!state.question.submitted;
  $("run-btn").disabled = !!state.question.submitted;
}

$("run-btn").addEventListener("click", () => {
  const code = $("code-editor").value;
  const button = $("run-btn");
  button.disabled = true;
  button.textContent = "Running…";
  $("test-results").textContent = "Starting Python…\nThe first run may take a little longer while Python loads.";

  const runId = ++pythonRunId;
  pythonPendingRun = { runId, code };

  if (pythonWorkerReady && pythonWorker) {
    sendPythonCode();
    return;
  }

  if (!pythonWorker) {
    try {
      pythonWorker = new Worker(new URL("python-runner.js", document.baseURI));
      pythonWorker.onmessage = handlePythonWorkerMessage;
      pythonWorker.onerror = (event) => {
        showPythonError("Could not start the Python runtime. Check your internet connection and try again.");
        console.error("Python worker error:", event.message || event);
        stopPythonWorker();
      };
      pythonLoadTimer = setTimeout(() => {
        showPythonError("Python took too long to load. Check your connection and try Run/Test again.");
        stopPythonWorker();
      }, 60000);
    } catch (err) {
      showPythonError("Your browser could not start the Python sandbox: " + err.message);
      stopPythonWorker();
    }
  }
});

function handlePythonWorkerMessage(event) {
  const message = event.data || {};

  if (message.type === "status") {
    $("test-results").textContent = message.message || "Loading Python…";
    return;
  }

  if (message.type === "ready") {
    pythonWorkerReady = true;
    if (pythonLoadTimer) clearTimeout(pythonLoadTimer);
    pythonLoadTimer = null;
    sendPythonCode();
    return;
  }

  if (message.type === "running") {
    $("test-results").textContent = "Running your code…";
    if (pythonRunTimer) clearTimeout(pythonRunTimer);
    pythonRunTimer = setTimeout(() => {
      showPythonError("Execution stopped because it ran for more than 3 seconds. Check for an infinite loop and try again.");
      stopPythonWorker();
    }, 3000);
    return;
  }

  if (message.type === "result") {
    if (pythonRunTimer) clearTimeout(pythonRunTimer);
    pythonRunTimer = null;
    const output = message.output || "(No output. Use print() to display values.)";
    $("test-results").textContent = output;
    finishPythonRun();
    return;
  }

  if (message.type === "error") {
    if (pythonRunTimer) clearTimeout(pythonRunTimer);
    pythonRunTimer = null;
    const parts = [];
    if (message.output) parts.push(message.output);
    parts.push(message.error || "Python encountered an error.");
    $("test-results").textContent = parts.join("\n");
    if (!pythonWorkerReady) {
      // Initialization failed; clear the worker so the next click can retry.
      stopPythonWorker();
    } else {
      finishPythonRun();
    }
  }
}

function sendPythonCode() {
  if (!pythonWorker || !pythonWorkerReady || !pythonPendingRun) return;
  if (pythonLoadTimer) clearTimeout(pythonLoadTimer);
  pythonLoadTimer = null;
  pythonWorker.postMessage({ type: "run", code: pythonPendingRun.code });
  pythonPendingRun = null;
}

function finishPythonRun() {
  $("run-btn").disabled = !!(state.question && state.question.submitted);
  $("run-btn").textContent = "Run / Test";
}

function showPythonError(message) {
  $("test-results").textContent = message;
  finishPythonRun();
}

function stopPythonWorker() {
  if (pythonWorker) pythonWorker.terminate();
  pythonWorker = null;
  pythonWorkerReady = false;
  pythonPendingRun = null;
  if (pythonRunTimer) clearTimeout(pythonRunTimer);
  if (pythonLoadTimer) clearTimeout(pythonLoadTimer);
  pythonRunTimer = null;
  pythonLoadTimer = null;
  finishPythonRun();
}

$("submit-btn").addEventListener("click", async () => {
  if (!confirm("Submit this answer? You will not be able to return to this question.")) {
    return;
  }

  const code = $("code-editor").value;
  $("submit-btn").disabled = true;
  $("save-status").textContent = "Submitting...";

  try {
    const result = await api("submit", {
      sessionToken: localStorage.getItem("assessmentSession"),
      questionId: state.question.id,
      code
    });

    state.question = null;
    localStorage.removeItem("assessmentSession");

    $("locked-message").textContent =
      "Your answer has been submitted. Wait for your teacher to give you your next question.";

    show("locked-screen");
    startStudentPolling();
  } catch (err) {
    $("save-status").textContent = "Submission failed";
    $("submit-btn").disabled = false;
    alert(err.message);
  }
});


// While a student is waiting, ask the existing login endpoint every 5 seconds.
// When the teacher advances them, login_ returns the new question and session token.
function startStudentPolling() {
  if (studentPollTimer) clearTimeout(studentPollTimer);
  if (state.role !== "student" || !state.student || !studentAccessCode || state.question) return;
  studentPollTimer = setTimeout(pollStudentStatus, 5000);
}

async function pollStudentStatus() {
  studentPollTimer = null;
  if (state.role !== "student" || !state.student || !studentAccessCode || state.question) return;

  try {
    const result = await api("login", { code: studentAccessCode });

    if (result.role === "student" && result.question) {
      state.student = result.student;
      state.question = result.question;
      if (result.sessionToken) {
        localStorage.setItem("assessmentSession", result.sessionToken);
      }
      $("student-status").textContent = `${result.student.name} — your next question is ready.`;
      renderStudent();
      return;
    }

    if (result.role === "student" && !result.question && !result.waiting) {
      $("locked-message").textContent = "Your assessment has been completed.";
      show("locked-screen");
      return;
    }
  } catch (err) {
    // A temporary network error should not log the student out. Try again shortly.
    console.warn("Could not check for the next question yet:", err);
  }

  startStudentPolling();
}

async function loadTeacherDashboard() {
  show("teacher-screen");

  try {
    const result = await api("teacherDashboard", {
      teacherToken: localStorage.getItem("assessmentTeacherToken")
    });

    state.teacherStudents = result.students;
    renderTeacherTable();
  } catch (err) {
    alert(err.message);
    show("login-screen");
  }
}

function renderTeacherTable() {
  const rows = state.teacherStudents.map(student => `
    <tr>
      <td>${escapeHtml(student.name)}</td>
      <td>${escapeHtml(student.currentQuestion || "Not started")}</td>
      <td><span class="status-pill">${escapeHtml(student.status)}</span></td>
      <td><button class="secondary view-student" data-id="${escapeHtml(student.id)}">View</button></td>
    </tr>
  `).join("");

  $("teacher-table-wrap").innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Student</th>
          <th>Current Question</th>
          <th>Status</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows || "<tr><td colspan='4'>No students found.</td></tr>"}</tbody>
    </table>
  `;

  document.querySelectorAll(".view-student").forEach(btn => {
    btn.addEventListener("click", () => viewStudent(btn.dataset.id));
  });
}

$("refresh-btn").addEventListener("click", loadTeacherDashboard);
$("close-detail").addEventListener("click", () => {
  $("teacher-detail").classList.add("hidden");
});

async function viewStudent(studentId) {
  try {
    const result = await api("teacherStudent", {
      teacherToken: localStorage.getItem("assessmentTeacherToken"),
      studentId
    });

    state.selectedStudent = result;
    renderTeacherDetail(result);
  } catch (err) {
    alert(err.message);
  }
}

function renderTeacherDetail(data) {
  $("teacher-detail").classList.remove("hidden");
  $("detail-name").textContent = data.student.name;
  $("detail-current").textContent =
    `Current question: ${data.currentQuestion || "None"}`;

  $("detail-code").textContent = data.currentSubmission?.code || "(No submission yet)";

  const options = data.nextOptions || [];
  $("next-options").innerHTML = options.length
    ? options.map(id => `<button data-next="${escapeHtml(id)}">${escapeHtml(id)}</button>`).join("")
    : "<span class='muted'>No next questions configured.</span>";

  document.querySelectorAll("#next-options button").forEach(btn => {
    btn.addEventListener("click", () => advanceStudent(data.student.id, btn.dataset.next));
  });

  $("detail-history").innerHTML = (data.history || []).map(item => `
    <div class="history-row">
      <strong>${escapeHtml(item.questionId)}</strong>
      — ${escapeHtml(item.timestamp)}
      — ${escapeHtml(item.teacherDecision || "Waiting for teacher decision")}
    </div>
  `).join("");
}

async function advanceStudent(studentId, nextQuestionId) {
  try {
    await api("advanceStudent", {
      teacherToken: localStorage.getItem("assessmentTeacherToken"),
      studentId,
      nextQuestionId
    });

    await loadTeacherDashboard();
    await viewStudent(studentId);
  } catch (err) {
    alert(err.message);
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
