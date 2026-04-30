# NAFS Question Generator

MCQ generator for Saudi math curriculum (grades 4–6). Powered by Gemini.

## Setup

1. Set env var: `GEMINI_API_KEY=your_key`
2. Install: `pip install -r requirements.txt`
3. Run locally: `python app.py`  →  http://localhost:8080

## Deploy

### Railway / Render / Fly.io
- Connect repo, set `GEMINI_API_KEY` as env var, deploy.
- Procfile already configured for gunicorn.

### Heroku
```
heroku create
heroku config:set GEMINI_API_KEY=your_key
git push heroku main
```

## Structure

```
nafs-deploy/
├── app.py              # Flask app + agent pipeline
├── requirements.txt
├── Procfile            # gunicorn for production
├── .env.example
├── data/               # Prompt libraries (grade 4/5/6)
├── templates/          # index.html
└── static/             # app.js, style.css
```
