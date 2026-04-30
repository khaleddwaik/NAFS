#!/usr/bin/env python3
"""
NAFS Question Generator — Static Demo (serves from test_results.json)
"""
import json, os, time, random
from pathlib import Path
from flask import Flask, render_template, request, jsonify, Response, stream_with_context
from flask_cors import CORS

BASE = Path(__file__).parent
DATA = BASE / "data"

PROMPT_LIBRARIES = {
    4: DATA / "prompt_library_grade4.json",
    5: DATA / "prompt_library_grade5.json",
    6: DATA / "prompt_library_grade6.json",
}

app = Flask(__name__)
CORS(app)

# ─── LIBRARY ──────────────────────────────────────────────────────────────────
_lib_cache = {}

def load_library(grade):
    if grade in _lib_cache:
        return _lib_cache[grade]
    p = PROMPT_LIBRARIES.get(grade)
    if p and p.exists():
        with open(p, encoding="utf-8") as f:
            _lib_cache[grade] = json.load(f)
        return _lib_cache[grade]
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

# ─── TEST DATA ─────────────────────────────────────────────────────────────────
_test_data = None

def load_test_data():
    global _test_data
    if _test_data is None:
        p = DATA / "test_results.json"
        if p.exists():
            with open(p, encoding="utf-8") as f:
                _test_data = json.load(f)
        else:
            _test_data = {}
    return _test_data

def pick_questions(grade, chapter_num, count=3):
    data = load_test_data()
    exact_key = f"G{grade}_Ch{chapter_num}_full"
    pool = []

    if exact_key in data:
        pool.append(data[exact_key])

    for k, v in data.items():
        if v.get("grade") == grade and v.get("chapter_num") != chapter_num and "_full" in k:
            pool.append(v)

    if len(pool) < count:
        for k, v in data.items():
            if v.get("grade") == grade and v not in pool:
                pool.append(v)

    if len(pool) < count:
        for k, v in data.items():
            if v not in pool:
                pool.append(v)

    random.shuffle(pool[1:])
    return pool[:count]

# ─── SSE ──────────────────────────────────────────────────────────────────────
def sse(event, data):
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"

def norm_criteria(v):
    if isinstance(v, bool):
        return {"pass": v, "note": ""}
    return v

def generate_stream(grade, chapter_num, difficulty, num_questions):
    try:
        chapters   = get_chapters(grade)
        ch_obj     = next((c for c in chapters if c["num"] == chapter_num), None)
        chapter_en = ch_obj["en"] if ch_obj else f"Chapter {chapter_num}"
        chapter_ar = ch_obj["ar"] if ch_obj else ""

        yield sse("chapter_info", {
            "chapter_num":   chapter_num,
            "chapter_en":    chapter_en,
            "chapter_ar":    chapter_ar,
            "lesson_count":  ch_obj["lesson_count"] if ch_obj else 0,
            "num_questions": num_questions,
        })

        yield sse("stage", {"stage": "controller", "status": "active",
                             "message": "Loading chapter context from Prompt Library..."})
        time.sleep(0.3)
        yield sse("library", {
            "found":   ch_obj["lesson_count"] if ch_obj else 0,
            "lessons": [l["en"] for l in (ch_obj["lessons"] if ch_obj else [])],
        })
        yield sse("controller_result", {
            "lesson_title_en":  chapter_en,
            "lesson_title_ar":  chapter_ar,
            "learning_outcome": "",
            "guidelines_count": 3,
            "instruction":      f"Generate a {difficulty}-level question for {chapter_en}.",
        })
        yield sse("stage", {"stage": "controller", "status": "done"})

        questions = pick_questions(grade, chapter_num, num_questions)

        for q_idx, q in enumerate(questions):
            yield sse("question_start", {"index": q_idx, "total": num_questions})
            time.sleep(0.2)

            yield sse("stage", {"stage": "teacher", "status": "active", "attempt": 1,
                                 "message": f"Generating question {q_idx+1}/{num_questions}..."})
            time.sleep(0.4)
            yield sse("draft_question", {"question": q.get("question", ""), "attempt": 1})
            yield sse("stage", {"stage": "teacher", "status": "done", "attempt": 1})

            yield sse("stage", {"stage": "critic", "status": "active", "attempt": 1,
                                 "message": f"Validating question {q_idx+1}/{num_questions}..."})
            time.sleep(0.3)

            criteria = q.get("criteria", {})
            normed   = {k: norm_criteria(v) for k, v in criteria.items()}

            yield sse("critic_result", {
                "attempt":  1,
                "verdict":  q.get("verdict", "APPROVED"),
                "score":    q.get("score", 9),
                "criteria": normed,
                "issues":   [],
                "feedback": "",
            })
            yield sse("stage", {"stage": "critic", "status": "done", "attempt": 1})

            raw_opts      = q.get("options", [])
            correct_label = q.get("correct_label", "A")
            options = [
                {"label": o["label"], "text": o["text"], "is_correct": o["label"] == correct_label}
                for o in raw_opts
            ]

            yield sse("question_ready", {
                "index":          q_idx,
                "total":          num_questions,
                "question":       q.get("question", ""),
                "options":        options,
                "correct_label":  correct_label,
                "correct_answer": q.get("correct_answer", ""),
                "explanation":    q.get("explanation", ""),
                "difficulty":     q.get("difficulty", difficulty),
                "topic_used":     q.get("topic_used", ""),
                "verdict":        q.get("verdict", "APPROVED"),
                "score":          q.get("score", 9),
                "criteria":       normed,
            })

            if q_idx < num_questions - 1:
                yield sse("gap", {"message": f"Generating question {q_idx+2}/{num_questions}..."})
                time.sleep(0.2)

        yield sse("all_done", {
            "grade":         grade,
            "chapter_num":   chapter_num,
            "chapter_en":    chapter_en,
            "chapter_ar":    chapter_ar,
            "difficulty":    difficulty,
            "mode":          "full",
            "num_questions": len(questions),
            "lesson_matched": chapter_en,
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
    num_questions = min(max(int(request.args.get("num_questions", 3)), 1), 10)

    if chapter_num is None:
        return jsonify({"error": "chapter required"}), 400
    if grade not in (4, 5, 6):
        return jsonify({"error": "grade must be 4, 5, or 6"}), 400

    return Response(
        stream_with_context(generate_stream(grade, chapter_num, difficulty, num_questions)),
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
    return jsonify({"status": "ok", "mode": "static-demo"})

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    print(f"NAFS Question Generator (demo) — http://localhost:{port}")
    app.run(host="0.0.0.0", port=port, debug=False)
