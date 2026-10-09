let state = {
  role: null,
  student: null,
  question: null,
  teacherStudents: [],
  selectedStudent: null
};

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

$("logout-btn").addEventListener("click", () => {
  state = { role: null, student: null, question: null };
  localStorage.removeItem("assessmentSession");
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
          : "Your assessment has been completed.";
        show("locked-screen");
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

  $("question-label").textContent = `Question ${state.question.id}`;
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

$("run-btn").addEventListener("click", async () => {
  // Phase 1 intentionally does not execute Python.
  // We will add the secure test runner after the assessment workflow is working.
  $("test-results").textContent =
    "Python testing will be connected here in Phase 2.\n\n" +
    "For now, this button confirms where your question-specific testing system will go.";
});

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
  } catch (err) {
    $("save-status").textContent = "Submission failed";
    $("submit-btn").disabled = false;
    alert(err.message);
  }
});

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
