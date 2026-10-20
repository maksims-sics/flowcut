"""Word timestamps for FlowCut with faster-whisper (large-v3-turbo, on the GPU when CUDA works).

Prints one JSON object per line on stdout: {"event": "status"|"progress"|"done", ...}.
usage: python -u transcribe_worker.py --wav AUDIO_16K.wav --out OUT.json [--lang en|auto] [--vocab "names"]
       [--model large-v3-turbo]
Output: {"model", "device", "language", "words": [{"w", "s", "e", "p"}], "segments": [{"s", "e", "text"}]}
"""
import argparse
import glob
import json
import os
import site
import sys

# Whisper leaves out "um" and "uh" unless the prompt shows them; this primes it to write them down (English only)
VERBATIM_PROMPT = "Umm, let me think, like, hmm... Okay, so, uh, here's what I'm, you know, thinking. I mean, er, yeah."


def emit(**event):
    print(json.dumps(event, ensure_ascii=False), flush=True)


def cuda_dlls():
    """Make pip-installed NVIDIA runtime DLLs (nvidia-cublas-cu12, nvidia-cudnn-cu12) visible on Windows."""
    for sp in site.getsitepackages() + [site.getusersitepackages()]:
        for d in glob.glob(os.path.join(sp, "nvidia", "*", "bin")):
            try:
                os.add_dll_directory(d)
            except (OSError, AttributeError):
                pass
            os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")


def load_model(name):
    from faster_whisper import WhisperModel
    import numpy as np
    cuda_dlls()
    try:
        emit(event="status", message=f"Loading Whisper {name} on the GPU")
        model = WhisperModel(name, device="cuda", compute_type="float16")
        list(model.transcribe(np.zeros(16000, dtype=np.float32), language="en")[0])  # fails fast without cuBLAS/cuDNN
        return model, "cuda", name
    except Exception as err:  # noqa: BLE001 - any CUDA problem means CPU
        emit(event="status", message=f"GPU unavailable ({str(err)[:80]}), using the CPU (slower)")
        fallback = "medium"
        return WhisperModel(fallback, device="cpu", compute_type="int8", cpu_threads=os.cpu_count() or 8), "cpu", fallback


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wav", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--lang", default="en")
    ap.add_argument("--vocab", default="")
    ap.add_argument("--model", default="large-v3-turbo")
    ap.add_argument("--no-verbatim", action="store_true", help="do not prime Whisper to keep filler words")
    a = ap.parse_args()

    model, device, name = load_model(a.model)
    emit(event="status", message=f"Transcribing on the {'GPU' if device == 'cuda' else 'CPU'}")
    verbatim = VERBATIM_PROMPT if a.lang == "en" and not a.no_verbatim else ""
    prompt = " ".join(p for p in (verbatim, a.vocab) if p).strip() or None
    segments, info = model.transcribe(a.wav, language=None if a.lang == "auto" else a.lang, beam_size=5,
                                      word_timestamps=True, vad_filter=True, initial_prompt=prompt,
                                      condition_on_previous_text=False)
    words, lines = [], []
    for s in segments:
        lines.append({"s": round(s.start, 3), "e": round(s.end, 3), "text": s.text.strip()})
        for w in s.words or []:
            text = w.word.strip()
            if text:
                words.append({"w": text, "s": round(w.start, 3), "e": round(w.end, 3), "p": round(w.probability, 3)})
        emit(event="progress", t=round(s.end, 2))
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump({"model": name, "device": device, "language": info.language, "words": words, "segments": lines},
                  f, ensure_ascii=False)
    emit(event="done", words=len(words))


if __name__ == "__main__":
    try:
        main()
    except Exception as err:  # noqa: BLE001 - report every failure to the app
        emit(event="error", message=str(err))
        sys.exit(1)
