/* ─── STATE ─────────────────────────────────────────────────────────────────── */
const state = {
  mode:         'full',
  grade:        6,
  difficulty:   'intermediate',
  numQuestions: 3,
  chapter:      null,   // { num, en, ar, lesson_count, lessons }
  chapters:     {},     // grade → array of chapter objects
  generating:   false,
  stats:        {},
  history:      [],

  // Quiz state
  questions:    [],     // array of question data objects
  answers:      {},     // index → selected label
  submitted:    false,
};

/* ─── INIT ──────────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  loadStats();
  loadChapters(state.grade);
  setupDifficultyRadios();
  loadHistory();
  initMobileTabs();
});

/* ─── STATS ─────────────────────────────────────────────────────────────────── */
async function loadStats() {
  try {
    const res  = await fetch('/api/library_stats');
    const data = await res.json();
    state.stats = data;
    for (const [grade, info] of Object.entries(data)) {
      const el = document.getElementById(`stat${grade}`);
      if (el) el.textContent = info.available ? `${info.count} lessons` : 'N/A';
    }
    updateGradeInfo();
  } catch (e) {
    log('Failed to load library stats', 'warn');
  }
}


/* ─── GRADE ─────────────────────────────────────────────────────────────────── */
function setGrade(grade) {
  state.grade   = grade;
  state.chapter = null;
  document.querySelectorAll('.grade-btn').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.grade) === grade);
  });
  updateGradeInfo();
  loadChapters(grade);
}

function updateGradeInfo() {
  const info = state.stats[String(state.grade)];
  const el   = document.getElementById('gradeInfoText');
  if (!el) return;
  if (info) {
    el.textContent = info.available
      ? `${info.count} lessons in library`
      : 'Library not yet generated';
  }
}

/* ─── DIFFICULTY ────────────────────────────────────────────────────────────── */
function setupDifficultyRadios() {
  document.querySelectorAll('.diff-option input').forEach(radio => {
    radio.addEventListener('change', () => {
      state.difficulty = radio.value;
      document.querySelectorAll('.diff-card').forEach(c => c.classList.remove('diff-card-active'));
      radio.closest('.diff-option').querySelector('.diff-card').classList.add('diff-card-active');
    });
  });
}


/* ─── CHAPTER SELECTOR ──────────────────────────────────────────────────────── */
async function loadChapters(grade) {
  const loading = document.getElementById('chapterLoading');
  const list    = document.getElementById('chapterList');
  const info    = document.getElementById('chapterSelectedInfo');

  loading.style.display = 'flex';
  list.style.display    = 'none';
  info.style.display    = 'none';

  if (state.chapters[grade]) {
    renderChapterList(state.chapters[grade]);
    return;
  }

  try {
    const res  = await fetch(`/api/chapters/${grade}`);
    const data = await res.json();
    state.chapters[grade] = data;
    renderChapterList(data);
  } catch (e) {
    loading.innerHTML = '<span style="color:var(--red)">Failed to load chapters</span>';
    log('Failed to load chapters', 'error');
  }
}

function renderChapterList(chapters) {
  const loading = document.getElementById('chapterLoading');
  const list    = document.getElementById('chapterList');

  loading.style.display = 'none';
  list.style.display    = 'flex';

  list.innerHTML = chapters.map(ch => `
    <div class="chapter-item ${state.chapter?.num === ch.num ? 'active' : ''}"
         onclick="selectChapter(${ch.num})">
      <div class="ch-num">Ch${ch.num}</div>
      <div class="ch-info">
        <div class="ch-title-en">${escHtml(ch.en)}</div>
        <div class="ch-title-ar">${escHtml(ch.ar)}</div>
      </div>
      <div class="ch-count">${ch.lesson_count}</div>
    </div>
  `).join('');
}

function selectChapter(num) {
  const chapters = state.chapters[state.grade] || [];
  const ch = chapters.find(c => c.num === num);
  if (!ch) return;
  state.chapter = ch;

  document.querySelectorAll('.chapter-item').forEach(el => {
    const n = parseInt(el.querySelector('.ch-num').textContent.replace('Ch', ''));
    el.classList.toggle('active', n === num);
  });

  const info = document.getElementById('chapterSelectedInfo');
  document.getElementById('csiTitle').textContent   = ch.en;
  document.getElementById('csiAr').textContent      = ch.ar;
  document.getElementById('csiLessons').textContent = `${ch.lesson_count} lessons in library`;
  info.style.display = 'block';

  log(`Chapter selected: Ch${num} — ${ch.en}`, 'info');
}

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]
  ));
}

/* ─── GENERATION ────────────────────────────────────────────────────────────── */
function startGeneration() {
  if (!state.chapter) { flashChapterList(); return; }
  if (state.generating) return;
  state.generating = true;
  state.questions  = [];
  state.answers    = {};
  state.submitted  = false;

  const btn = document.getElementById('generateBtn');
  btn.disabled = true;
  btn.classList.add('loading');
  btn.querySelector('.btn-text').textContent = 'Generating...';

  showPipelineFlow();
  resetPipelineStages();
  resetQuizPanel();
  if (window.innerWidth <= 900) switchTab('pipeline');
  showResultLoading('Initializing pipeline...');
  clearLog();

  log(`Starting — Ch${state.chapter.num}: ${state.chapter.en} | Grade ${state.grade} | ${state.difficulty} | ${state.mode} | ${state.numQuestions}Q`, 'info');

  const url = `/api/generate?chapter=${state.chapter.num}&grade=${state.grade}&difficulty=${state.difficulty}&mode=${state.mode}&num_questions=${state.numQuestions}`;
  const es  = new EventSource(url);

  es.addEventListener('stage',              e => handleStage(JSON.parse(e.data)));
  es.addEventListener('chapter_info',       e => handleChapterInfo(JSON.parse(e.data)));
  es.addEventListener('library',            e => handleLibrary(JSON.parse(e.data)));
  es.addEventListener('controller_result',  e => handleController(JSON.parse(e.data)));
  es.addEventListener('draft_question',     e => handleDraft(JSON.parse(e.data)));
  es.addEventListener('critic_result',      e => handleCritic(JSON.parse(e.data)));
  es.addEventListener('revision',           e => handleRevision(JSON.parse(e.data)));
  es.addEventListener('question_start',     e => handleQuestionStart(JSON.parse(e.data)));
  es.addEventListener('question_ready',     e => handleQuestionReady(JSON.parse(e.data)));
  es.addEventListener('all_done',           e => handleAllDone(JSON.parse(e.data)));
  es.addEventListener('error',              e => handleError(JSON.parse(e.data)));
  es.addEventListener('done',               () => {
    es.close();
    state.generating = false;
    btn.disabled = false;
    btn.classList.remove('loading');
    btn.querySelector('.btn-text').textContent = 'Generate Questions';
  });

  es.onerror = () => {
    log('Connection error', 'error');
    es.close();
    state.generating = false;
    btn.disabled = false;
    btn.classList.remove('loading');
    btn.querySelector('.btn-text').textContent = 'Generate Questions';
  };
}

/* ─── EVENT HANDLERS ────────────────────────────────────────────────────────── */
function handleStage(data) {
  const { stage, status, message } = data;
  const stageMap = { controller: 'stageController', teacher: 'stageTeacher', critic: 'stageCritic' };
  const el = document.getElementById(stageMap[stage]);
  if (!el) return;
  el.className = 'pipeline-stage';
  if (status === 'active') {
    el.classList.add('stage-active');
    if (message) updateLoadingText(message);
    log(message || `${stage} active`, 'info');
  } else if (status === 'done') {
    el.classList.add('stage-done');
  }
}

function handleChapterInfo(data) {
  log(`Chapter: ${data.chapter_en} (${data.lesson_count} lessons)`, 'info');
}

function handleLibrary(data) {
  if (data.found > 0) {
    log(`Library: ${data.found} lesson(s) matched — ${data.lessons.join(', ')}`, 'success');
  } else {
    log(`Library: no matches for grade ${state.grade}`, 'warn');
  }
}

function handleController(data) {
  document.getElementById('ctrlLesson').textContent      = data.lesson_title_en || '—';
  document.getElementById('ctrlGuides').textContent      = data.guidelines_count ? `${data.guidelines_count} selected` : '—';
  document.getElementById('ctrlInstruction').textContent = data.instruction || '—';
  log(`Controller: matched "${data.lesson_title_en}"`, 'success');
}

function handleDraft(data) {
  document.getElementById('draftQuestion').textContent = data.question || '—';
  log(`Teacher: draft generated (attempt ${data.attempt})`, 'success');
  updateLoadingText('Question drafted — validating...');
}

function handleCritic(data) {
  const { attempt, verdict, score, criteria, issues, feedback } = data;

  const pct  = Math.round((score / 10) * 100);
  const fill = document.getElementById('scoreFill');
  const num  = document.getElementById('scoreNum');
  fill.style.width      = pct + '%';
  fill.style.background = score >= 8 ? 'var(--green)' : score >= 5 ? '#f59e0b' : 'var(--red)';
  num.textContent       = `${score}/10`;

  const critKeys = ['language','difficulty','scope','correctness','clarity','arabic_quality','distractors'];
  critKeys.forEach(key => {
    const el   = document.getElementById(`crit-${key}`);
    const info = criteria?.[key];
    if (el && info) {
      el.className = `criteria-item ${info.pass ? 'pass' : 'fail'}`;
      el.querySelector('.crit-icon').textContent = info.pass ? '✓' : '✗';
    }
  });

  const revBanner = document.getElementById('revisionBanner');
  if (verdict === 'REVISION' && feedback) {
    revBanner.style.display = 'flex';
    document.getElementById('revisionText').textContent = feedback;
  } else {
    revBanner.style.display = 'none';
  }

  log(`Critic: ${verdict} — score ${score}/10${issues?.length ? ' — ' + issues[0] : ''}`,
      verdict === 'APPROVED' ? 'success' : 'warn');
}

function handleRevision(data) {
  log(`Revision (attempt ${data.attempt}): ${String(data.feedback).slice(0, 80)}`, 'warn');
  updateLoadingText(`Revision attempt ${data.attempt + 1}/3...`);
}

function handleQuestionStart(data) {
  // server sends 0-based index
  const idx   = data.index + 1;
  const total = data.total;

  const bar = document.getElementById('qProgressBar');
  bar.style.display = 'block';
  document.getElementById('qProgressLabel').textContent = `Question ${idx} of ${total}`;
  document.getElementById('qProgressFill').style.width  = `${((idx - 1) / total) * 100}%`;

  resetPipelineStages();
  updateLoadingText(`Generating question ${idx} of ${total}...`);

  ensureProgressChip(idx, total, 'loading');
  addLoadingCard(idx, total);

  log(`Question ${idx}/${total} — generating...`, 'info');
}

function handleQuestionReady(data) {
  // server sends 0-based index
  const idx   = data.index + 1;
  const total = data.total;
  const { question, options, correct_label, verdict, score } = data;

  state.questions[idx - 1] = data;

  document.getElementById('qProgressLabel').textContent = `Question ${idx} of ${total}`;
  document.getElementById('qProgressFill').style.width  = `${(idx / total) * 100}%`;

  setChipState(idx, 'unanswered');
  replaceLoadingCard(idx, data);
  if (window.innerWidth <= 900 && idx === 1) switchTab('quiz');

  log(`Question ${idx}/${total} ready — verdict: ${verdict} score: ${score}/10`, 'success');
}

function handleAllDone(data) {
  const { grade, chapter_num, chapter_en, chapter_ar, difficulty, mode, num_questions } = data;

  // Hide loading
  document.getElementById('resultLoading').style.display = 'none';

  // Show quiz content
  document.getElementById('quizContent').style.display = 'flex';
  document.getElementById('resultEmpty').style.display  = 'none';

  // Meta chips
  const ordinals = {4: '4th Grade', 5: '5th Grade', 6: '6th Grade'};
  document.getElementById('metaGrade').textContent   = ordinals[grade] || `Grade ${grade}`;
  document.getElementById('metaDiff').textContent    = difficulty;
  document.getElementById('metaChapter').textContent = `Ch${chapter_num}: ${chapter_en}`;
  document.getElementById('metaMode').textContent    = mode === 'full' ? 'Full Pipeline' : 'Teacher Only';

  // Show submit button + header right
  document.getElementById('quizHeaderRight').style.display = 'flex';
  checkSubmitReady();

  // Pipeline verdict box
  const vbox = document.getElementById('verdictBox');
  vbox.style.display = 'block';
  document.getElementById('verdictInner').className  = 'verdict-inner approved';
  document.getElementById('verdictIcon').textContent = '✓';
  document.getElementById('verdictText').textContent = `${num_questions} question${num_questions !== 1 ? 's' : ''} ready`;
  document.getElementById('verdictMeta').textContent = `${chapter_en} · Grade ${grade}`;

  // Progress bar complete
  document.getElementById('qProgressFill').style.width = '100%';

  addToHistory(data);
  log(`All ${num_questions} questions ready!`, 'success');
}

function handleError(data) {
  log(`Error: ${data.message}`, 'error');
  showResultError(data.message);
}

/* ─── QUIZ CARDS ────────────────────────────────────────────────────────────── */
function resetQuizPanel() {
  document.getElementById('questionCards').innerHTML    = '';
  document.getElementById('quizProgressChips').innerHTML = '';
  document.getElementById('scoreSummary').style.display  = 'none';
  document.getElementById('quizContent').style.display   = 'none';
  document.getElementById('quizHeaderRight').style.display = 'none';
  document.getElementById('submitAllBtn').style.display   = 'none';
  document.getElementById('resultEmpty').style.display    = 'none';
  document.getElementById('qProgressBar').style.display   = 'none';
}

function addLoadingCard(index, total) {
  const cards = document.getElementById('questionCards');
  const div   = document.createElement('div');
  div.className = 'mcq-card';
  div.id        = `card-${index}`;
  div.innerHTML = `
    <div class="mcq-loading-state">
      <div class="loading-dots"><span></span><span></span><span></span></div>
      <div class="mcq-loading-label">Generating question ${index} of ${total}...</div>
    </div>`;
  cards.appendChild(div);

  // Show quiz content panel (loading state)
  document.getElementById('resultEmpty').style.display  = 'none';
  document.getElementById('resultLoading').style.display = 'none';
  document.getElementById('quizContent').style.display  = 'flex';
}

function replaceLoadingCard(index, data) {
  const card = document.getElementById(`card-${index}`);
  if (!card) return;

  const { question, options, correct_label, explanation, topic_used, difficulty: diff, score } = data;

  card.innerHTML = `
    <div class="mcq-header">
      <span class="mcq-num">Q${index}</span>
      <span class="mcq-topic">${escHtml(topic_used || '')}</span>
      <span class="mcq-score-badge">${score}/10</span>
    </div>
    <div class="mcq-question arabic-text">${escHtml(question)}</div>
    <div class="mcq-options" id="options-${index}">
      ${options.map(opt => `
        <button class="mcq-option" data-label="${escHtml(opt.label)}"
                onclick="selectOption(${index}, '${escHtml(opt.label)}')">
          <span class="opt-label">${escHtml(opt.label)}</span>
          <span class="opt-text arabic-text">${escHtml(opt.text)}</span>
          <span class="opt-icon"></span>
        </button>
      `).join('')}
    </div>
    <div class="mcq-explanation arabic-text" id="explanation-${index}" style="display:none">
      ${escHtml(explanation || '')}
    </div>`;

  card.dataset.correctLabel = correct_label;
  card.classList.add('card-ready');
}

function ensureProgressChip(index, total, initialState) {
  const chips = document.getElementById('quizProgressChips');
  let chip = document.getElementById(`chip-${index}`);
  if (!chip) {
    chip = document.createElement('div');
    chip.className = `q-chip ${initialState}`;
    chip.id        = `chip-${index}`;
    chip.textContent = index;
    chip.title       = `Question ${index}`;
    chip.onclick     = () => scrollToCard(index);
    chips.appendChild(chip);
  }
  return chip;
}

function setChipState(index, newState) {
  const chip = document.getElementById(`chip-${index}`);
  if (!chip) return;
  chip.className = `q-chip ${newState}`;
}

function scrollToCard(index) {
  const card = document.getElementById(`card-${index}`);
  if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ─── OPTION SELECT ─────────────────────────────────────────────────────────── */
function selectOption(cardIndex, label) {
  if (state.submitted) return;
  const qData = state.questions[cardIndex - 1];
  if (!qData) return;

  // Already answered — no re-selection
  if (state.answers[cardIndex]) return;

  state.answers[cardIndex] = label;

  const card         = document.getElementById(`card-${cardIndex}`);
  const correctLabel = card?.dataset.correctLabel;
  const isCorrect    = label === correctLabel;

  const opts = card.querySelectorAll('.mcq-option');
  opts.forEach(btn => {
    btn.disabled = true;
    const lbl = btn.dataset.label;
    if (lbl === correctLabel) {
      btn.classList.add('correct');
      btn.querySelector('.opt-icon').textContent = '✓';
    } else if (lbl === label && !isCorrect) {
      btn.classList.add('wrong');
      btn.querySelector('.opt-icon').textContent = '✗';
    }
  });

  card.classList.add(isCorrect ? 'submitted-correct' : 'submitted-wrong');
  setChipState(cardIndex, isCorrect ? 'correct' : 'incorrect');

  const expEl = document.getElementById(`explanation-${cardIndex}`);
  if (expEl) expEl.style.display = 'block';

  checkSubmitReady();
}

function checkSubmitReady() {
  const total     = state.questions.length;
  const answered  = Object.keys(state.answers).length;
  const submitBtn = document.getElementById('submitAllBtn');
  if (!submitBtn) return;
  // Show "Submit Quiz" only when every question is answered (to show score summary)
  submitBtn.style.display = (total > 0 && answered === total && !state.submitted) ? 'inline-flex' : 'none';
}

/* ─── SUBMIT ────────────────────────────────────────────────────────────────── */
function submitAll() {
  if (state.submitted) return;
  state.submitted = true;

  document.getElementById('submitAllBtn').style.display = 'none';

  let correct = 0;
  const total = state.questions.length;

  state.questions.forEach((qData, i) => {
    const index        = i + 1;
    const card         = document.getElementById(`card-${index}`);
    const correctLabel = card?.dataset.correctLabel;
    const chosen       = state.answers[index];
    if (!card) return;
    if (chosen === correctLabel) correct++;
  });

  showScoreSummary(correct, total);
  log(`Quiz submitted — ${correct}/${total} correct`, correct === total ? 'success' : 'info');
}

function showScoreSummary(correct, total) {
  const pct    = total > 0 ? Math.round((correct / total) * 100) : 0;
  const circle = document.getElementById('scoreCircle');
  const circumference = 326.7;

  document.getElementById('ssNum').textContent = `${correct}/${total}`;
  document.getElementById('ssPct').textContent = `${pct}%`;

  const label = pct === 100 ? 'Perfect score!' : pct >= 70 ? 'Good work!' : pct >= 50 ? 'Keep practicing' : 'Keep trying!';
  document.getElementById('ssLabel').textContent = label;

  const summary = document.getElementById('scoreSummary');
  summary.style.display = 'flex';

  // Animate ring
  if (circle) {
    circle.style.stroke = pct >= 70 ? '#2e7d52' : pct >= 50 ? '#f59e0b' : '#e53e3e';
    const offset = circumference * (1 - correct / total);
    setTimeout(() => { circle.style.strokeDashoffset = offset; }, 100);
  }
}

/* ─── REVIEW / RESET ────────────────────────────────────────────────────────── */
function reviewMode() {
  // Scroll to first wrong card
  for (let i = 0; i < state.questions.length; i++) {
    const index = i + 1;
    const chip  = document.getElementById(`chip-${index}`);
    if (chip?.classList.contains('incorrect')) {
      scrollToCard(index);
      return;
    }
  }
  // All correct — scroll to top of quiz
  document.getElementById('questionCards').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function resetQuiz() {
  state.questions = [];
  state.answers   = {};
  state.submitted = false;

  resetQuizPanel();
  resetPipelineStages();
  showPipelineIdle();

  document.getElementById('resultEmpty').style.display = 'flex';
  document.querySelector('.empty-icon').textContent    = '◌';
  document.querySelector('.empty-text').textContent    = 'Generated questions will appear here as a quiz';

  const btn = document.getElementById('generateBtn');
  btn.disabled = false;
  btn.classList.remove('loading');
  btn.querySelector('.btn-text').textContent = 'Generate Questions';
}

/* ─── LOADING / RESULT HELPERS ──────────────────────────────────────────────── */
function showResultLoading(msg) {
  document.getElementById('resultEmpty').style.display  = 'none';
  document.getElementById('quizContent').style.display  = 'none';
  document.getElementById('resultLoading').style.display = 'flex';
  updateLoadingText(msg);
}

function updateLoadingText(msg) {
  const el = document.getElementById('loadingText');
  if (el) el.textContent = msg;
}

function showResultError(msg) {
  document.getElementById('resultLoading').style.display = 'none';
  document.getElementById('resultEmpty').style.display   = 'flex';
  document.querySelector('.empty-icon').textContent = '⚠';
  document.querySelector('.empty-text').textContent = `Error: ${msg}`;
}

/* ─── PIPELINE UI ───────────────────────────────────────────────────────────── */
function showPipelineFlow() {
  document.getElementById('pipelineIdle').style.display = 'none';
  const flow = document.getElementById('pipelineFlow');
  flow.style.display = 'flex';

  const ctrl = document.getElementById('stageController');
  if (ctrl) {
    ctrl.style.display = state.mode === 'full' ? 'block' : 'none';
    const conn = ctrl.querySelector('.stage-connector');
    if (conn) conn.style.display = state.mode === 'full' ? 'flex' : 'none';
  }
}

function showPipelineIdle() {
  document.getElementById('pipelineIdle').style.display = 'flex';
  document.getElementById('pipelineFlow').style.display = 'none';
}

function resetPipelineStages() {
  ['stageController','stageTeacher','stageCritic'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.className = 'pipeline-stage';
  });

  document.getElementById('draftQuestion').textContent      = '—';
  document.getElementById('ctrlLesson').textContent         = '—';
  document.getElementById('ctrlGuides').textContent         = '—';
  document.getElementById('ctrlInstruction').textContent    = '—';
  document.getElementById('scoreFill').style.width          = '0';
  document.getElementById('scoreNum').textContent           = '—/10';
  document.getElementById('revisionBanner').style.display   = 'none';
  document.getElementById('verdictBox').style.display       = 'none';

  ['language','difficulty','scope','correctness','clarity','arabic_quality','distractors'].forEach(k => {
    const el = document.getElementById(`crit-${k}`);
    if (el) {
      el.className = 'criteria-item';
      el.querySelector('.crit-icon').textContent = '—';
    }
  });
}

/* ─── HISTORY ───────────────────────────────────────────────────────────────── */
function addToHistory(data) {
  const entry = {
    chapter_num: data.chapter_num,
    chapter_en:  data.chapter_en,
    grade:       data.grade,
    difficulty:  data.difficulty,
    mode:        data.mode,
    num_questions: data.num_questions,
    ts:          Date.now(),
  };
  state.history.unshift(entry);
  if (state.history.length > 8) state.history = state.history.slice(0, 8);
  saveHistory();
  renderHistory();
}

function renderHistory() {
  const list    = document.getElementById('historyList');
  const section = document.getElementById('historySection');
  if (!state.history.length) { section.style.display = 'none'; return; }
  section.style.display = 'block';
  list.innerHTML = state.history.map((item, i) => `
    <div class="history-item">
      <div class="history-dot history-dot-approved"></div>
      <div class="history-topic">Ch${item.chapter_num}: ${escHtml(item.chapter_en)}</div>
      <div class="history-meta">G${item.grade} · ${item.difficulty[0].toUpperCase()} · ${item.num_questions}Q</div>
    </div>
  `).join('');
}

function clearHistory() {
  state.history = [];
  saveHistory();
  renderHistory();
  document.getElementById('historySection').style.display = 'none';
}

function saveHistory() {
  try { localStorage.setItem('nafs_history', JSON.stringify(state.history)); } catch (e) {}
}

function loadHistory() {
  try {
    const h = localStorage.getItem('nafs_history');
    if (h) { state.history = JSON.parse(h); renderHistory(); }
  } catch (e) {}
}

/* ─── LOG ───────────────────────────────────────────────────────────────────── */
function log(msg, level = 'info') {
  const entries = document.getElementById('logEntries');
  const now = new Date().toLocaleTimeString('en', { hour12: false });
  const div = document.createElement('div');
  div.className = 'log-entry';
  div.innerHTML = `<span class="log-time">${now}</span><span class="log-msg ${level}">${escHtml(msg)}</span>`;
  entries.appendChild(div);
  entries.scrollTop = entries.scrollHeight;
}

function clearLog() {
  document.getElementById('logEntries').innerHTML = '';
}

function toggleLog() {
  const content = document.getElementById('logContent');
  const label   = document.getElementById('logToggleLabel');
  const open    = content.style.display === 'none';
  content.style.display = open ? 'block' : 'none';
  label.textContent     = open ? '▼ Pipeline Log' : '▲ Pipeline Log';
}

/* ─── MOBILE TABS ───────────────────────────────────────────────────────────── */
const TAB_PANELS = { config: 'panel-config', pipeline: 'panel-pipeline', quiz: 'panel-result' };
let activeTab = 'config';

function switchTab(tab) {
  if (window.innerWidth > 900) return;
  activeTab = tab;
  Object.entries(TAB_PANELS).forEach(([t, cls]) => {
    const el = document.querySelector('.' + cls);
    if (el) el.classList.toggle('mobile-active', t === tab);
  });
  ['config','pipeline','quiz'].forEach(t => {
    const btn = document.getElementById('tab' + t.charAt(0).toUpperCase() + t.slice(1));
    if (btn) btn.classList.toggle('active', t === tab);
  });
}

function initMobileTabs() {
  if (window.innerWidth <= 900) {
    Object.values(TAB_PANELS).forEach(cls => {
      const el = document.querySelector('.' + cls);
      if (el) el.classList.remove('mobile-active');
    });
    switchTab('config');
  } else {
    Object.values(TAB_PANELS).forEach(cls => {
      const el = document.querySelector('.' + cls);
      if (el) { el.style.display = ''; el.classList.remove('mobile-active'); }
    });
  }
}

window.addEventListener('resize', initMobileTabs);

/* ─── HELPERS ───────────────────────────────────────────────────────────────── */
function flashChapterList() {
  const list = document.getElementById('chapterList');
  list.style.outline      = '2px solid var(--red)';
  list.style.borderRadius = '6px';
  setTimeout(() => { list.style.outline = ''; }, 1200);
}
