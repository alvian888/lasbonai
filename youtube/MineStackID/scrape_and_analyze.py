#!/usr/bin/env python3
"""
MineStackID YouTube Channel — Scraper & Sentiment Analyzer
Scrapes transcripts from all videos, then performs per-video sentiment analysis
using local Ollama LLM.
"""

import csv
import json
import os
import sys
import time
import re
import requests
from pathlib import Path

try:
    from youtube_transcript_api import YouTubeTranscriptApi
    from youtube_transcript_api.proxies import WebshareProxyConfig
except ImportError:
    print("ERROR: youtube-transcript-api not installed")
    sys.exit(1)

BASE_DIR = Path(__file__).parent
VIDEO_LIST = BASE_DIR / "video-list.txt"
TRANSCRIPTS_DIR = BASE_DIR / "transcripts"
RESULTS_FILE = BASE_DIR / "sentiment-results.json"
REPORT_FILE = BASE_DIR / "sentiment-report.csv"
SUMMARY_FILE = BASE_DIR / "analysis-summary.md"

OLLAMA_URL = "http://127.0.0.1:11435/v1/chat/completions"
MODEL = "rahmatginanjar120/lasbonai:latest"

TRANSCRIPTS_DIR.mkdir(exist_ok=True)


def load_video_list():
    """Load video list from yt-dlp flat playlist output."""
    videos = []
    with open(VIDEO_LIST, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            # Split from right to handle titles containing '|'
            # Format: video_id|title (may contain |)|upload_date|duration|views
            parts = line.rsplit("|", 3)  # split into 4 parts from the right
            if len(parts) >= 4:
                id_and_title = parts[0]  # "video_id|title..."
                first_pipe = id_and_title.index("|")
                video_id_str = id_and_title[:first_pipe]
                title_str = id_and_title[first_pipe + 1:]
                vid = {
                    "id": video_id_str,
                    "title": title_str,
                    "upload_date": parts[1] if parts[1] != "NA" else "",
                    "duration": float(parts[2]) if parts[2] != "NA" else 0,
                    "views": int(float(parts[3])) if parts[3] != "NA" else 0,
                }
                videos.append(vid)
    return videos


def fetch_transcript(video_id):
    """Fetch transcript for a single video. Try id, en, then any available."""
    transcript_file = TRANSCRIPTS_DIR / f"{video_id}.txt"
    if transcript_file.exists():
        return transcript_file.read_text(encoding="utf-8")

    try:
        ytt_api = YouTubeTranscriptApi()
        transcript = ytt_api.fetch(video_id, languages=["id", "en"])
        text = " ".join(
            snippet.text for snippet in transcript.snippets
        )
        # Clean up
        text = re.sub(r'\[.*?\]', '', text)  # Remove [Music] etc.
        text = re.sub(r'\s+', ' ', text).strip()
        transcript_file.write_text(text, encoding="utf-8")
        return text
    except Exception as e:
        # Try any available language
        try:
            transcript_list = ytt_api.list(video_id)
            if transcript_list:
                first_lang = transcript_list[0].language_code
                transcript = ytt_api.fetch(video_id, languages=[first_lang])
                text = " ".join(
                    snippet.text for snippet in transcript.snippets
                )
                text = re.sub(r'\[.*?\]', '', text)
                text = re.sub(r'\s+', ' ', text).strip()
                transcript_file.write_text(text, encoding="utf-8")
                return text
        except Exception:
            pass
        return None


def analyze_sentiment(title, transcript_text):
    """Use Ollama LLM to analyze sentiment of video content."""
    # Truncate transcript to ~2000 chars for LLM context
    snippet = transcript_text[:2000] if transcript_text else "(no transcript available)"

    prompt = f"""Analyze the sentiment of this YouTube video content. 
Title: "{title}"
Transcript excerpt: "{snippet}"

Provide your analysis in this EXACT JSON format only, no other text:
{{
  "overall_sentiment": "positive" or "negative" or "neutral" or "mixed",
  "positive_pct": <number 0-100>,
  "negative_pct": <number 0-100>,
  "neutral_pct": <number 0-100>,
  "key_topics": ["topic1", "topic2", "topic3"],
  "brief_summary": "1-2 sentence summary in Indonesian"
}}"""

    try:
        resp = requests.post(
            OLLAMA_URL,
            json={
                "model": MODEL,
                "messages": [
                    {
                        "role": "system",
                        "content": "You are a sentiment analysis expert. Always respond with valid JSON only. No markdown, no explanation."
                    },
                    {"role": "user", "content": prompt}
                ],
                "temperature": 0.3,
                "max_tokens": 500
            },
            timeout=120
        )
        resp.raise_for_status()
        content = resp.json()["choices"][0]["message"]["content"].strip()
        # Extract JSON from response
        json_match = re.search(r'\{[^{}]*\}', content, re.DOTALL)
        if json_match:
            result = json.loads(json_match.group())
            # Validate required fields
            for key in ["overall_sentiment", "positive_pct", "negative_pct", "neutral_pct"]:
                if key not in result:
                    result[key] = "unknown" if "sentiment" in key else 0
            return result
        return {"overall_sentiment": "unknown", "positive_pct": 0, "negative_pct": 0, "neutral_pct": 0, "error": "parse_failed"}
    except Exception as e:
        return {"overall_sentiment": "error", "positive_pct": 0, "negative_pct": 0, "neutral_pct": 0, "error": str(e)}


def generate_summary(results):
    """Generate markdown summary report."""
    total = len(results)
    has_sentiment = [r for r in results if r.get("sentiment", {}).get("overall_sentiment") not in ("error", "unknown")]
    
    sentiments = {"positive": 0, "negative": 0, "neutral": 0, "mixed": 0}
    total_pos_pct = 0
    total_neg_pct = 0
    total_neu_pct = 0
    
    for r in has_sentiment:
        s = r["sentiment"]["overall_sentiment"]
        sentiments[s] = sentiments.get(s, 0) + 1
        total_pos_pct += r["sentiment"].get("positive_pct", 0)
        total_neg_pct += r["sentiment"].get("negative_pct", 0)
        total_neu_pct += r["sentiment"].get("neutral_pct", 0)
    
    n = len(has_sentiment) or 1
    avg_pos = total_pos_pct / n
    avg_neg = total_neg_pct / n
    avg_neu = total_neu_pct / n
    
    # Sort by views
    top_views = sorted(results, key=lambda x: x.get("views", 0), reverse=True)[:10]
    # Most positive
    most_positive = sorted(has_sentiment, key=lambda x: x["sentiment"].get("positive_pct", 0), reverse=True)[:5]
    # Most negative
    most_negative = sorted(has_sentiment, key=lambda x: x["sentiment"].get("negative_pct", 0), reverse=True)[:5]

    md = f"""# Analisis Sentimen Channel YouTube @MineStackID

## Ringkasan Umum
- **Total Video Dianalisis**: {total}
- **Video dengan Transcript**: {len([r for r in results if r.get("has_transcript")])}
- **Video Berhasil Dianalisis Sentimen**: {len(has_sentiment)}

## Distribusi Sentimen Keseluruhan
| Sentimen | Jumlah Video | Persentase |
|----------|-------------|------------|
| Positif  | {sentiments['positive']} | {sentiments['positive']/n*100:.1f}% |
| Negatif  | {sentiments['negative']} | {sentiments['negative']/n*100:.1f}% |
| Netral   | {sentiments['neutral']} | {sentiments['neutral']/n*100:.1f}% |
| Campuran | {sentiments['mixed']} | {sentiments['mixed']/n*100:.1f}% |

## Rata-rata Persentase Sentimen
- **Positif**: {avg_pos:.1f}%
- **Negatif**: {avg_neg:.1f}%
- **Netral**: {avg_neu:.1f}%

## Top 10 Video Terbanyak Ditonton
| # | Judul | Views | Sentimen | Pos% | Neg% |
|---|-------|-------|----------|------|------|
"""
    for i, v in enumerate(top_views, 1):
        s = v.get("sentiment", {})
        md += f"| {i} | {v['title'][:60]}{'...' if len(v['title'])>60 else ''} | {v.get('views',0):,} | {s.get('overall_sentiment','?')} | {s.get('positive_pct',0)}% | {s.get('negative_pct',0)}% |\n"

    md += f"""
## Top 5 Video Paling Positif
| # | Judul | Pos% | Views |
|---|-------|------|-------|
"""
    for i, v in enumerate(most_positive, 1):
        md += f"| {i} | {v['title'][:60]}{'...' if len(v['title'])>60 else ''} | {v['sentiment'].get('positive_pct',0)}% | {v.get('views',0):,} |\n"

    md += f"""
## Top 5 Video Paling Negatif
| # | Judul | Neg% | Views |
|---|-------|------|-------|
"""
    for i, v in enumerate(most_negative, 1):
        md += f"| {i} | {v['title'][:60]}{'...' if len(v['title'])>60 else ''} | {v['sentiment'].get('negative_pct',0)}% | {v.get('views',0):,} |\n"

    md += f"""
## Insight Kunci
Analisis di atas menunjukkan pola sentimen dari {total} video yang dipublikasikan oleh channel @MineStackID.
Data ini dapat digunakan untuk memahami tone/nada channel, topik yang paling menarik perhatian penonton,
dan korelasi antara sentimen video dengan jumlah view yang didapat.

---
*Generated automatically using Ollama LLM ({MODEL})*
"""
    return md


def main():
    print("=" * 60)
    print("MineStackID YouTube Channel — Scraper & Sentiment Analyzer")
    print("=" * 60)

    # Load videos
    videos = load_video_list()
    print(f"\nTotal videos found: {len(videos)}")

    # Load existing results if any (for resume)
    existing_results = {}
    if RESULTS_FILE.exists():
        try:
            data = json.loads(RESULTS_FILE.read_text(encoding="utf-8"))
            existing_results = {r["id"]: r for r in data}
            print(f"Resuming: {len(existing_results)} videos already processed")
        except Exception:
            pass

    results = []
    total = len(videos)

    for i, video in enumerate(videos, 1):
        vid = video["id"]
        
        # Check if already processed
        if vid in existing_results:
            results.append(existing_results[vid])
            continue

        print(f"\n[{i}/{total}] {video['title'][:70]}...")
        
        # Fetch transcript
        print(f"  Fetching transcript for {vid}...", end=" ")
        transcript = fetch_transcript(vid)
        has_transcript = transcript is not None
        print(f"{'OK (' + str(len(transcript)) + ' chars)' if has_transcript else 'FAILED'}")

        # Analyze sentiment
        if has_transcript or video["title"]:
            print(f"  Analyzing sentiment...", end=" ")
            sentiment = analyze_sentiment(video["title"], transcript or "")
            print(f"→ {sentiment.get('overall_sentiment', '?')} (pos:{sentiment.get('positive_pct',0)}% neg:{sentiment.get('negative_pct',0)}%)")
        else:
            sentiment = {"overall_sentiment": "unknown", "positive_pct": 0, "negative_pct": 0, "neutral_pct": 0}

        result = {
            **video,
            "has_transcript": has_transcript,
            "transcript_length": len(transcript) if transcript else 0,
            "sentiment": sentiment,
        }
        results.append(result)

        # Save progress every 10 videos
        if i % 10 == 0:
            RESULTS_FILE.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"  [Saved progress: {i}/{total}]")

        # Small delay to not overload Ollama
        time.sleep(0.5)

    # Final save
    RESULTS_FILE.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n\nResults saved to {RESULTS_FILE}")

    # Generate CSV report
    with open(REPORT_FILE, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["video_id", "title", "views", "duration_sec", "has_transcript",
                         "overall_sentiment", "positive_pct", "negative_pct", "neutral_pct", "key_topics"])
        for r in results:
            s = r.get("sentiment", {})
            writer.writerow([
                r["id"], r["title"], r.get("views", 0), r.get("duration", 0),
                r.get("has_transcript", False),
                s.get("overall_sentiment", ""), s.get("positive_pct", 0),
                s.get("negative_pct", 0), s.get("neutral_pct", 0),
                "|".join(s.get("key_topics", []))
            ])
    print(f"CSV report saved to {REPORT_FILE}")

    # Generate markdown summary
    summary = generate_summary(results)
    SUMMARY_FILE.write_text(summary, encoding="utf-8")
    print(f"Summary saved to {SUMMARY_FILE}")

    print("\n✓ DONE!")


if __name__ == "__main__":
    main()
