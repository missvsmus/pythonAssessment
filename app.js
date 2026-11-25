let state = {
  role: null,
  student: null,
  question: null,
  questionNumber: 1,
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

function isWrittenQuestion() {
  return String(state.question?.type || "code").toLowerCase() === "written";
}

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


// CodeMirror adds syntax highlighting without changing how answers are submitted.
// If its CDN is unavailable, the original textarea and Tab handling still work.
let codeMirrorEditor = null;
if (window.CodeMirror) {
  codeMirrorEditor = CodeMirror.fromTextArea($("code-editor"), {
    mode: "python",
    theme: "material-darker",
    lineNumbers: false,
    indentUnit: 4,
    tabSize: 4,
    indentWithTabs: false,
    lineWrapping: true,
    extraKeys: {
      Tab: cm => cm.replaceSelection("    ", "end", "+input"),
      "Shift-Tab": cm => cm.execCommand("indentLess")
    }
  });
}
function getEditorCode() {
  return codeMirrorEditor ? codeMirrorEditor.getValue() : $("code-editor").value;
}
function setEditorCode(code) {
  if (codeMirrorEditor) codeMirrorEditor.setValue(code);
  else $("code-editor").value = code;
}
function setEditorDisabled(disabled) {
  $("code-editor").disabled = disabled;
  if (codeMirrorEditor) codeMirrorEditor.setOption("readOnly", disabled ? "nocursor" : false);
}
if (!codeMirrorEditor) {
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

}

// Reset all students and archive submissions
$("reset-all-btn").addEventListener("click", () => {
  alert("Reset button clicked!");
  const confirmed = window.confirm(
    "Are you sure you want to reset ALL students?\n\n" +
    "This will:\n" +
    "- Generate new access codes for everyone\n" +
    "- Return everyone to the first question\n" +
    "- Log out all currently active students\n" +
    "- Archive the current submissions\n" +
    "- Create a fresh submissions sheet\n\n" +
    "This action cannot be easily undone."
  );

  if (!confirmed) return;

  const button = $("reset-all-btn");
  button.disabled = true;
  button.textContent = "Resetting students...";

  $("add-message").className = "message";

  try {
    const result = await apiRequest({
      action: "resetAllStudents",
      teacherToken: teacherToken
    });

    showMessage(
      "add-message",
      `Successfully reset ${result.resetCount} students. Previous submissions were archived in "${result.archivedSheet}". You can now print the new access cards.`,
      "success"
    );

    $("student-result").style.display = "none";

  } catch (error) {
    showMessage("add-message", error.message, "error");

  } finally {
    button.disabled = false;
    button.textContent = "Reset All Students";
  }
});

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
      state.questionNumber = result.questionNumber || 1;
      studentAccessCode = code;

      if (result.sessionToken) {
        localStorage.setItem("assessmentSession", result.sessionToken);
      } else {
        localStorage.removeItem("assessmentSession");
      }

      $("student-status").textContent = result.student.name;
      $("logout-btn").classList.remove("hidden");

      if (!result.question) {
        const completed = !result.waiting;
      
        $("completion-title").textContent = completed
          ? "Congratulations! You have completed your quiz!"
          : "Answer Submitted";
      
        $("completion-icon").textContent = completed ? "🎉" : "✓";
      
        $("locked-message").textContent = completed
          ? "You have successfully completed your assessment. Well done!"
          : "Your answer has been submitted. Your teacher will give you your next question.";
      
        $("locked-screen").classList.toggle("completed", completed);
      
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

  const written = isWrittenQuestion();
  const submitted = !!state.question.submitted;
  
  $("question-label").textContent = `Question ${state.questionNumber || 1}`;
  $("assessment-status").textContent =
    submitted ? "Submitted" : "In progress";

  $("question-title").textContent =
    state.question.title || `Challenge ${state.question.id}`;

  $("question-text").textContent = state.question.text || "";

  if (state.question.starterText) {
    $("starter-info").classList.remove("hidden");
    $("starter-text").textContent = state.question.starterText;
  } else {
    $("starter-info").classList.add("hidden");
  }

  // Switch between the Python editor and written-response textarea.
  $("code-input-area").classList.toggle("hidden", written);
  $("written-input-area").classList.toggle("hidden", !written);

  // Update the editor heading.
  $("editor-title").textContent = written
    ? "Your Written Response"
    : "Your Python Code";

  // Only show Python testing controls for code questions.
  $("run-btn").classList.toggle("hidden", written);
  $("test-results").classList.toggle("hidden", written);

  // Load the appropriate starting content.
  if (written) {
    $("written-response").value = state.question.starterAnswer || "";
    $("written-response").disabled = submitted;
  } else {
    console.log("Question received:", state.question);
    console.log("Starter code received:", state.question.starterCode);
    setEditorCode(state.question.starterCode || "");
    setEditorDisabled(submitted);
  }
  
  $("submit-btn").disabled = submitted;
  $("run-btn").disabled = submitted;
}

$("run-btn").addEventListener("click", () => {
  if (isWrittenQuestion()) return;
  
  const code = getEditorCode();
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
  if (!state.question) return;

  if (!confirm("Submit this answer? You will not be able to return to this question.")) {
    return;
  }

  const written = isWrittenQuestion();

  // Read from the appropriate input.
  const answer = written
    ? $("written-response").value
    : getEditorCode();

  $("submit-btn").disabled = true;
  $("save-status").textContent = "Submitting...";

  try {
    const submissionData = {
      sessionToken: localStorage.getItem("assessmentSession"),
      questionId: state.question.id
    };

    // Send the response using the field expected by the backend.
    if (written) {
      submissionData.answer = answer;
    } else {
      submissionData.code = answer;
    }

    await api("submit", submissionData);

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
      state.questionNumber = result.questionNumber || 1;
      if (result.sessionToken) {
        localStorage.setItem("assessmentSession", result.sessionToken);
      }
      $("student-status").textContent = `${result.student.name} — your next question is ready.`;
      renderStudent();
      return;
    }

    if (result.role === "student" && !result.question && !result.waiting) {
      $("completion-title").textContent =
        "Congratulations! You have completed your quiz!";
    
      $("completion-icon").textContent = "🎉";
    
      $("locked-message").textContent =
        "You have successfully completed your assessment. Well done!";
    
      $("locked-screen").classList.add("completed");
    
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
      <td><span class="status-pill status-${escapeHtml(String(student.status || "").trim().toLowerCase())}">${escapeHtml(student.status)}</span></td>
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

  // Display the question the student was answering.
  $("detail-question-text").textContent =
    data.question
      ? `${data.question.title || data.question.id}\n\n${data.question.text || ""}`
      : "(Question details unavailable)";
  
  const submission = data.currentSubmission;
  
  $("detail-code").textContent =
    submission?.response ??
    submission?.answer ??
    submission?.code ??
    "(No submission yet)";
  
  $("detail-code").style.whiteSpace = "pre-wrap";
  
  $("detail-code").style.fontFamily =
    submission?.type === "written" ? "inherit" : "monospace";

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

  // Reset the pathway whenever a different student is opened.
  /*$("pathway-section").classList.add("hidden");
  $("detail-pathway").replaceChildren();
  $("load-pathway-btn").textContent = "Show Question Pathway";
  */
}


function renderQuestionPathway(data) {
  const container = $("detail-pathway");
  const questions = data.pathway || [];

  if (!questions.length) {
    container.textContent = "No question pathway information available.";
    return;
  }

  const completed = new Set(
    (data.history || []).map(item => String(item.questionId))
  );

  const currentQuestion = String(data.currentQuestion || "");

  const byId = new Map(
    questions.map(q => [String(q.id), q])
  );

  // Calculate the horizontal level of each question.
  // The first question is the starting point.
  const ranks = new Map();
  const visited = new Set();

  function assignRanks(startId, startRank) {
    const queue = [{ id: startId, rank: startRank }];
    let maxRank = startRank;

    while (queue.length) {
      const item = queue.shift();
      const id = String(item.id);

      if (visited.has(id)) continue;
      if (!byId.has(id)) continue;

      visited.add(id);
      ranks.set(id, item.rank);
      maxRank = Math.max(maxRank, item.rank);

      const question = byId.get(id);

      (question.nextOptions || []).forEach(nextId => {
        const next = String(nextId);

        if (!visited.has(next) && byId.has(next)) {
          queue.push({
            id: next,
            rank: item.rank + 1
          });
        }
      });
    }

    return maxRank;
  }

  let maxRank = 0;

  // Start with the first question in the Questions sheet.
  if (questions.length) {
    maxRank = assignRanks(String(questions[0].id), 0);
  }

  // Also include disconnected questions or pathways.
  questions.forEach(q => {
    const id = String(q.id);

    if (!visited.has(id)) {
      maxRank = Math.max(
        maxRank,
        assignRanks(id, maxRank + 1)
      );
    }
  });

  // Group questions by horizontal level.
  const columns = new Map();

  questions.forEach(q => {
    const id = String(q.id);
    const rank = ranks.get(id) || 0;

    if (!columns.has(rank)) {
      columns.set(rank, []);
    }

    columns.get(rank).push(q);
  });

  const sortedRanks = [...columns.keys()].sort((a, b) => a - b);

  const nodeWidth = 190;
  const nodeHeight = 76;
  const horizontalGap = 90;
  const verticalGap = 45;
  const margin = 30;

  const maxRows = Math.max(
    ...[...columns.values()].map(column => column.length)
  );

  const svgWidth =
    margin * 2 +
    (sortedRanks.length - 1) * (nodeWidth + horizontalGap) +
    nodeWidth;

  const svgHeight =
    margin * 2 +
    maxRows * (nodeHeight + verticalGap);

  const positions = new Map();

  sortedRanks.forEach((rank, columnIndex) => {
    const column = columns.get(rank);

    column.forEach((q, rowIndex) => {
      positions.set(String(q.id), {
        x: margin + columnIndex * (nodeWidth + horizontalGap),
        y: margin + rowIndex * (nodeHeight + verticalGap)
      });
    });
  });

  // Draw connections first so they appear behind the question boxes.
  let edges = "";

  questions.forEach(q => {
    const sourceId = String(q.id);
    const source = positions.get(sourceId);

    (q.nextOptions || []).forEach(nextId => {
      const targetId = String(nextId);
      const target = positions.get(targetId);

      if (!source || !target) return;

      const startX = source.x + nodeWidth;
      const startY = source.y + nodeHeight / 2;
      const endX = target.x;
      const endY = target.y + nodeHeight / 2;

      const controlOffset = Math.max(
        35,
        Math.abs(endX - startX) / 2
      );

      edges += `
        <path
          class="pathway-edge"
          d="M ${startX} ${startY}
             C ${startX + controlOffset} ${startY},
               ${endX - controlOffset} ${endY},
               ${endX} ${endY}"
          marker-end="url(#pathway-arrow)"
        />
      `;
    });
  });

  // Draw each question box.
  let nodes = "";

  questions.forEach(q => {
    const id = String(q.id);
    const pos = positions.get(id);

    if (!pos) return;

    let status = "incomplete";
    let statusText = "Not completed";

    if (completed.has(id)) {
      status = "completed";
      statusText = "Completed";
    } else if (id === currentQuestion) {
      status = "current";
      statusText = "Current question";
    }

    const title = String(q.title || id);
    const displayTitle = title.length > 24
      ? title.substring(0, 21) + "..."
      : title;

    nodes += `
      <g>
        <rect
          class="pathway-node ${status}"
          x="${pos.x}"
          y="${pos.y}"
          width="${nodeWidth}"
          height="${nodeHeight}"
          rx="9"
        />

        <text
          class="pathway-node-text"
          x="${pos.x + nodeWidth / 2}"
          y="${pos.y + 27}"
        >${escapeHtml(displayTitle)}</text>

        <text
          class="pathway-status-text"
          x="${pos.x + nodeWidth / 2}"
          y="${pos.y + 49}"
        >${escapeHtml(id)} · ${statusText}</text>
      </g>
    `;
  });

  container.innerHTML = `
    <svg
      class="pathway-svg"
      width="${svgWidth}"
      height="${svgHeight}"
      viewBox="0 0 ${svgWidth} ${svgHeight}"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Student question pathway"
    >
      <defs>
        <marker
          id="pathway-arrow"
          markerWidth="8"
          markerHeight="8"
          refX="6"
          refY="3"
          orient="auto"
        >
          <path d="M0,0 L0,6 L7,3 z" fill="#9ca3af"/>
        </marker>
      </defs>

      ${edges}
      ${nodes}
    </svg>

    <div class="pathway-legend">
      <div class="pathway-legend-item">
        <span class="pathway-legend-colour completed"></span>
        Completed
      </div>

      <div class="pathway-legend-item">
        <span class="pathway-legend-colour current"></span>
        Current question
      </div>

      <div class="pathway-legend-item">
        <span class="pathway-legend-colour incomplete"></span>
        Not completed
      </div>
    </div>
  `;
}

/*$("load-pathway-btn").addEventListener("click", () => {
  const section = $("pathway-section");
  const button = $("load-pathway-btn");

  // Hide the pathway if it is already visible.
  if (!section.classList.contains("hidden")) {
    section.classList.add("hidden");
    button.textContent = "Show Question Pathway";
    return;
  }

  // Generate the diagram only when requested.
  if (state.selectedStudent) {
    renderQuestionPathway(state.selectedStudent);
    section.classList.remove("hidden");
    button.textContent = "Hide Question Pathway";
  }
});*/

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
