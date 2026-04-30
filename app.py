#!/usr/bin/env python3
"""
NAFS Question Generator — Deployment App
Drop prompt_library_grade4/5/6.json into data/ folder, then run.
"""
import json, os, re, time, random
from pathlib import Path
from flask import Flask, render_template, request, jsonify, Response, stream_with_context
from flask_cors import CORS
import google.generativeai as genai

# load .env if present
_env = Path(__file__).parent / ".env"
if _env.exists():
    for _line in _env.read_text().splitlines():
        _line = _line.strip()
        if _line and not _line.startswith("#") and "=" in _line:
            _k, _v = _line.split("=", 1)
            os.environ.setdefault(_k.strip(), _v.strip())

# ─── CONFIG ───────────────────────────────────────────────────────────────────
API_KEY   = os.environ.get("GEMINI_API_KEY", "")
MODEL     = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
MAX_LOOPS = 3
BASE      = Path(__file__).parent
DATA      = BASE / "data"

PROMPT_LIBRARIES = {
    4: DATA / "prompt_library_grade4.json",
    5: DATA / "prompt_library_grade5.json",
    6: DATA / "prompt_library_grade6.json",
}

if API_KEY:
    genai.configure(api_key=API_KEY)

app = Flask(__name__)
CORS(app)

# ─── LIBRARY ──────────────────────────────────────────────────────────────────
_cache = {}

def load_library(grade):
    if grade in _cache:
        return _cache[grade]
    p = PROMPT_LIBRARIES.get(grade)
    if p and p.exists():
        with open(p, encoding="utf-8") as f:
            _cache[grade] = json.load(f)
        return _cache[grade]
    return []

def get_chapters(grade):
    seen = {}
    for e in load_library(grade):
        ch = e["chapter"]
        if ch not in seen:
            seen[ch] = {"num": ch, "en": e["chapter_title"]["en"],
                        "ar": e["chapter_title"]["ar"], "lesson_count": 0, "lessons": []}
        seen[ch]["lesson_count"] += 1
        seen[ch]["lessons"].append({"en": e["lesson_title"]["en"], "ar": e["lesson_title"]["ar"]})
    return sorted(seen.values(), key=lambda c: c["num"])

def get_chapter_lessons(grade, chapter_num):
    return [e for e in load_library(grade) if e["chapter"] == chapter_num]

def format_context(entries):
    parts = []
    for e in entries:
        lo    = e.get("learning_outcome_source", "") or ""
        lo_obj = e.get("learning_objective", {})
        lo_en = lo_obj.get("en", "") if isinstance(lo_obj, dict) else ""
        g_text = ""
        for i, g in enumerate(e.get("guidelines", []), 1):
            if isinstance(g, dict):
                g_text += f"  {i}. {g.get('en','')}\n     {g.get('ar','')}\n"
            else:
                g_text += f"  {i}. {g}\n"
        s_text = ""
        for s in e.get("questions", [])[:3]:
            s_text += f"  Q: {s.get('question','')}\n  A: {s.get('expected_answer','')}\n  Difficulty: {s.get('difficulty','?')}\n\n"
        parts.append(
            f"=== {e['lesson_title']['en']} ({e['lesson_title']['ar']}) ===\n"
            f"Chapter: {e['chapter_title']['en']}\nLO: {lo}\nObjective: {lo_en}\n"
            f"Guidelines:\n{g_text}Samples:\n{s_text}"
        )
    return "\n\n".join(parts)

def strip_fences(text):
    text = text.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        inner = lines[1:-1] if lines[-1].strip() == "```" else lines[1:]
        text = "\n".join(inner).strip()
    return text

def call_agent(system, user_message, retries=4):
    agent = genai.GenerativeModel(model_name=MODEL, system_instruction=system)
    for attempt in range(retries):
        try:
            return json.loads(strip_fences(agent.generate_content(user_message).text))
        except Exception as e:
            msg = str(e)
            if "429" in msg and attempt < retries - 1:
                wait = 20 * (attempt + 1)
                time.sleep(wait)
            else:
                raise

def shuffle_options(correct, distractors):
    """Return list of {label, text, is_correct} with randomised A/B/C/D order."""
    pool = [{"text": correct, "is_correct": True}] + \
           [{"text": d, "is_correct": False} for d in distractors[:3]]
    random.shuffle(pool)
    labels = ["A", "B", "C", "D"]
    return [{"label": labels[i], **pool[i]} for i in range(len(pool))]

# ─── AGENT PROMPTS ────────────────────────────────────────────────────────────

CONTROLLER_SYSTEM = """\
You are the Controller Agent in a Saudi national math curriculum question generation system.

Your job:
1. Receive a user request: chapter, grade level, difficulty
2. Review the curriculum context retrieved from the Prompt Library
3. Select and summarize the MOST RELEVANT guidelines and sample questions for the Teacher Agent
4. Output a structured brief for the Teacher Agent in this exact JSON format:

{
  "lesson_title_en": "...",
  "lesson_title_ar": "...",
  "learning_outcome": "...",
  "grade": <number>,
  "difficulty": "basic|intermediate|advanced",
  "key_guidelines": ["guideline 1 in English", "guideline 2 in English"],
  "style_reference": ["sample Arabic question 1", "sample Arabic question 2"],
  "teacher_instruction": "One sentence instructing the Teacher what to generate."
}

Return ONLY the JSON. No markdown. No extra text.
"""

TEACHER_SYSTEM = """\
You are the Teacher Agent — an expert Saudi math question writer for grades 4–6
(McGraw-Hill Saudi curriculum — سلسلة ماك غرو هيل للرياضيات).

You receive a brief and generate ONE multiple-choice question with exactly 3 distractors.

STRICT RULES:
1. question, correct_answer, AND all distractors MUST be entirely in Arabic (فصحى). Zero English.
2. Difficulty matches exactly: basic / intermediate / advanced.
3. Scope strictly to the lesson topic and grade level.
4. Distractors must be PLAUSIBLE but WRONG — common student misconceptions, off-by-one errors,
   wrong operation results. Not obviously silly answers.
5. If you receive revision feedback, address EVERY point raised.
6. Do NOT repeat a question already in previously_generated list if provided.

Return:
{
  "question": "<Arabic question text>",
  "correct_answer": "<correct Arabic answer — short, matchable>",
  "distractors": ["<wrong option 1>", "<wrong option 2>", "<wrong option 3>"],
  "explanation": "<brief Arabic explanation of why the correct answer is right>",
  "difficulty": "basic|intermediate|advanced",
  "topic_used": "<lesson topic in English>"
}

Return ONLY the JSON. No markdown. No extra text.
"""

TEACHER_DIRECT_SYSTEM = """\
You are the Teacher Agent — an expert Saudi math question writer for grades 4–6
(McGraw-Hill Saudi curriculum — سلسلة ماك غرو هيل للرياضيات).

You receive a chapter and difficulty and generate ONE multiple-choice question with exactly 3 distractors.

STRICT RULES:
1. question, correct_answer, AND all distractors MUST be entirely in Arabic (فصحى). Zero English.
2. Difficulty matches exactly: basic / intermediate / advanced.
3. Scope strictly to the chapter topic and grade level.
4. Distractors must be PLAUSIBLE but WRONG — common student misconceptions.
5. If you receive revision feedback, address EVERY point raised.
6. Do NOT repeat a question already in previously_generated list if provided.

Return:
{
  "question": "<Arabic question text>",
  "correct_answer": "<correct Arabic answer — short, matchable>",
  "distractors": ["<wrong option 1>", "<wrong option 2>", "<wrong option 3>"],
  "explanation": "<brief Arabic explanation of why the correct answer is right>",
  "difficulty": "basic|intermediate|advanced",
  "topic_used": "<lesson topic in English>"
}

Return ONLY the JSON. No markdown. No extra text.
"""

CRITIC_SYSTEM = """\
You are the Critic Agent — a senior curriculum validator for Saudi national math (grades 4–6).

Evaluate the multiple-choice question strictly and return:
{
  "verdict": "APPROVED" | "REVISION",
  "score": <integer 1-10>,
  "criteria": {
    "language":      {"pass": true|false, "note": "..."},
    "difficulty":    {"pass": true|false, "note": "..."},
    "scope":         {"pass": true|false, "note": "..."},
    "correctness":   {"pass": true|false, "note": "..."},
    "clarity":       {"pass": true|false, "note": "..."},
    "arabic_quality":{"pass": true|false, "note": "..."},
    "distractors":   {"pass": true|false, "note": "..."}
  },
  "issues": ["issue 1", "issue 2"],
  "feedback": "Specific revision instructions. Empty string if APPROVED."
}

Criteria:
1. LANGUAGE      — 100% Arabic everywhere. Critical failure if any English.
2. DIFFICULTY    — Matches requested level. Critical failure if wrong.
3. SCOPE         — Grade/chapter-appropriate only.
4. CORRECTNESS   — Correct answer is mathematically right. Critical failure if wrong.
5. CLARITY       — Question is unambiguous.
6. ARABIC QUALITY— Correct MSA grammar and math terminology.
7. DISTRACTORS   — All 3 distractors are plausible but wrong. Critical failure if any distractor is also correct.

Score ≥ 8 AND no critical failure → APPROVED. Otherwise → REVISION.
Return ONLY the JSON. No markdown.
"""

# ─── SSE ──────────────────────────────────────────────────────────────────────

def sse(event, data):
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"

def generate_one_question(grade, chapter_en, chapter_ar, chapter_num, difficulty, mode,
                           brief, teacher_system, previously_generated):
    """Run Teacher→Critic loop for one question. Yields SSE events, returns final question dict."""
    question_obj  = None
    critic_result = None
    feedback      = ""

    for attempt in range(1, MAX_LOOPS + 1):
        yield sse("stage", {"stage": "teacher", "status": "active", "attempt": attempt,
                             "message": f"Generating question (attempt {attempt}/{MAX_LOOPS})..."})

        if mode == "full" and brief:
            user_msg = json.dumps(brief, ensure_ascii=False, indent=2)
        else:
            user_msg = (
                f"Generate a {difficulty}-level MCQ for grade {grade}.\n"
                f"Chapter: {chapter_num} — {chapter_en}\nDifficulty: {difficulty}"
            )
        if previously_generated:
            user_msg += f"\n\nDo NOT repeat these questions:\n" + \
                        "\n".join(f"- {q}" for q in previously_generated[-5:])
        if feedback:
            user_msg += f"\n\nREVISION FEEDBACK FROM CRITIC:\n{feedback}"

        question_obj = call_agent(teacher_system, user_msg)
        yield sse("draft_question", {
            "question":    question_obj.get("question", ""),
            "attempt":     attempt,
        })
        yield sse("stage", {"stage": "teacher", "status": "done", "attempt": attempt})

        yield sse("stage", {"stage": "critic", "status": "active", "attempt": attempt,
                             "message": f"Validating question (attempt {attempt}/{MAX_LOOPS})..."})
        critic_result = call_agent(CRITIC_SYSTEM,
            f"Grade: {grade}\nChapter: {chapter_en}\nRequested Difficulty: {difficulty}\n\n"
            f"MCQ to Evaluate:\n{json.dumps(question_obj, ensure_ascii=False, indent=2)}")
        verdict = critic_result.get("verdict", "REVISION")

        yield sse("critic_result", {
            "attempt":  attempt,
            "verdict":  verdict,
            "score":    critic_result.get("score", 0),
            "criteria": critic_result.get("criteria", {}),
            "issues":   critic_result.get("issues", []),
            "feedback": critic_result.get("feedback", ""),
        })
        yield sse("stage", {"stage": "critic", "status": "done", "attempt": attempt})

        if verdict == "APPROVED":
            break
        feedback = critic_result.get("feedback", "")
        if attempt < MAX_LOOPS:
            yield sse("revision", {"attempt": attempt, "feedback": feedback})

    # Build final question with shuffled options
    options = shuffle_options(
        question_obj.get("correct_answer", ""),
        question_obj.get("distractors", [])
    )
    correct_label = next((o["label"] for o in options if o["is_correct"]), "A")

    return {
        "question":       question_obj.get("question", ""),
        "correct_answer": question_obj.get("correct_answer", ""),
        "correct_label":  correct_label,
        "options":        options,
        "explanation":    question_obj.get("explanation", ""),
        "difficulty":     difficulty,
        "topic_used":     question_obj.get("topic_used", ""),
        "verdict":        critic_result.get("verdict", "?") if critic_result else "?",
        "score":          critic_result.get("score", 0)    if critic_result else 0,
        "criteria":       critic_result.get("criteria", {})if critic_result else {},
    }


def generate_stream(grade, chapter_num, difficulty, mode, num_questions):
    try:
        lessons    = get_chapter_lessons(grade, chapter_num)
        chapter_en = lessons[0]["chapter_title"]["en"] if lessons else f"Chapter {chapter_num}"
        chapter_ar = lessons[0]["chapter_title"]["ar"] if lessons else ""

        yield sse("chapter_info", {
            "chapter_num": chapter_num, "chapter_en": chapter_en,
            "chapter_ar":  chapter_ar,  "lesson_count": len(lessons),
            "num_questions": num_questions,
        })

        # ── Controller (full mode) ────────────────────────────────────────
        brief = None
        matched_lesson = None

        if mode == "full":
            yield sse("stage", {"stage": "controller", "status": "active",
                                 "message": "Loading chapter context from Prompt Library..."})
            time.sleep(0.3)

            if lessons:
                context = format_context(lessons)
                matched_lesson = lessons[0]["lesson_title"]["en"]
                yield sse("library", {"found": len(lessons),
                                       "lessons": [e["lesson_title"]["en"] for e in lessons]})
            else:
                context = f"No library for grade {grade} ch {chapter_num}. Use: {chapter_en}."
                yield sse("library", {"found": 0, "lessons": []})

            yield sse("stage", {"stage": "controller", "status": "active",
                                 "message": "Controller selecting lesson context..."})
            brief = call_agent(CONTROLLER_SYSTEM,
                f"User Request:\n  Grade: {grade}\n  Chapter: {chapter_num} — {chapter_en} ({chapter_ar})\n"
                f"  Difficulty: {difficulty}\n\nPrompt Library Context:\n{context}")
            yield sse("controller_result", {
                "lesson_title_en":  brief.get("lesson_title_en", ""),
                "lesson_title_ar":  brief.get("lesson_title_ar", ""),
                "learning_outcome": (brief.get("learning_outcome", "") or "")[:120],
                "guidelines_count": len(brief.get("key_guidelines", [])),
                "instruction":      brief.get("teacher_instruction", ""),
            })
            yield sse("stage", {"stage": "controller", "status": "done"})

        teacher_system     = TEACHER_SYSTEM if mode == "full" else TEACHER_DIRECT_SYSTEM
        all_questions      = []
        previously_gen     = []

        # ── Generate N questions ──────────────────────────────────────────
        for q_idx in range(num_questions):
            yield sse("question_start", {"index": q_idx, "total": num_questions})

            gen = generate_one_question(
                grade, chapter_en, chapter_ar, chapter_num,
                difficulty, mode, brief, teacher_system, previously_gen
            )
            final_q = None
            try:
                while True:
                    yield next(gen)
            except StopIteration as e:
                final_q = e.value

            if final_q is None:
                continue

            all_questions.append(final_q)
            previously_gen.append(final_q["question"])

            yield sse("question_ready", {
                "index":          q_idx,
                "total":          num_questions,
                "question":       final_q["question"],
                "options":        final_q["options"],
                "correct_label":  final_q["correct_label"],
                "correct_answer": final_q["correct_answer"],
                "explanation":    final_q["explanation"],
                "difficulty":     final_q["difficulty"],
                "topic_used":     final_q["topic_used"],
                "verdict":        final_q["verdict"],
                "score":          final_q["score"],
                "criteria":       final_q["criteria"],
            })

            # Small gap between questions
            if q_idx < num_questions - 1:
                yield sse("gap", {"message": f"Generating question {q_idx + 2}/{num_questions}..."})
                time.sleep(1)

        yield sse("all_done", {
            "grade":        grade,
            "chapter_num":  chapter_num,
            "chapter_en":   chapter_en,
            "chapter_ar":   chapter_ar,
            "difficulty":   difficulty,
            "mode":         mode,
            "num_questions": len(all_questions),
            "lesson_matched": matched_lesson or chapter_en,
        })
        yield sse("done", {"success": True})

    except Exception as e:
        yield sse("error", {"message": str(e)})
        yield sse("done", {"success": False})


# ─── ROUTES ───────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/api/generate")
def api_generate():
    chapter_num   = request.args.get("chapter", type=int)
    grade         = int(request.args.get("grade", 6))
    difficulty    = request.args.get("difficulty", "intermediate").lower()
    mode          = request.args.get("mode", "full")
    num_questions = min(max(int(request.args.get("num_questions", 1)), 1), 10)

    if not API_KEY:
        return jsonify({"error": "GEMINI_API_KEY not set"}), 500
    if chapter_num is None:
        return jsonify({"error": "chapter required"}), 400
    if grade not in (4, 5, 6):
        return jsonify({"error": "grade must be 4, 5, or 6"}), 400
    if difficulty not in ("basic", "intermediate", "advanced"):
        return jsonify({"error": "invalid difficulty"}), 400
    if mode not in ("full", "teacher_only"):
        return jsonify({"error": "mode must be full or teacher_only"}), 400

    return Response(
        stream_with_context(generate_stream(grade, chapter_num, difficulty, mode, num_questions)),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

@app.route("/api/chapters/<int:grade>")
def api_chapters(grade):
    return jsonify(get_chapters(grade))

@app.route("/api/library_stats")
def api_library_stats():
    return jsonify({
        str(g): {"count": len(load_library(g)), "available": PROMPT_LIBRARIES[g].exists()}
        for g in (4, 5, 6)
    })

@app.route("/health")
def health():
    return jsonify({"status": "ok", "api_key_set": bool(API_KEY)})

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    print(f"NAFS Question Generator — http://localhost:{port}")
    app.run(host="0.0.0.0", port=port, debug=False)
