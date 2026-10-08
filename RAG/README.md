# RAG: diagnostic knowledge for press-stamp-01 and robot-weld-01

A self-contained retrieval-augmented generation module over the ten technical PDFs in
`PRESS_STAMP/` and `ROBOT_WELD/`. It is the knowledge component of the Cognitive DataOps project:
a diagnostic agent hands it a question or an abnormal reading and gets back the relevant technical
evidence with source metadata, a grounded answer and confidence information. It does not replace
the agent, and nothing outside `RAG/` is touched or imported.

```
PDF -> local extraction (PyMuPDF, tables kept as grids) -> structure-aware chunks
    -> Gemini embeddings (cached forever by content hash) -> FAISS index on disk

query -> local analysis (machine, sensor, intent, readings) -> machine filter
      -> dense search + BM25 -> rank fusion + local rerank -> stage-aware context
      -> Gemini 3.5 Flash Lite -> grounded, cited answer
```

Gemini is used for exactly two things: embeddings and the final answer.

## Installation

```bash
cd RAG
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

Python 3.11 or newer. Tested on Python 3.13, macOS arm64.

## API key setup

```bash
cp .env.example .env      # then put your key in GEMINI_API_KEY
```

The key is read from the `GEMINI_API_KEY` environment variable (`.env` is loaded automatically).
It is never written in code, and `.env` is ignored by git.

## Model configuration

| Setting | Default | Notes |
|---|---|---|
| `GEMINI_GENERATION_MODEL` | `gemini-3.5-flash-lite` | final answer and the optional judge |
| `GEMINI_EMBEDDING_MODEL` | `gemini-embedding-2` | 3072 dimensions, unit-normalised |
| `GEMINI_GENERATION_RPM_LIMIT` / `_RPD_LIMIT` | 10 / 350 | real limits 15 / 500 |
| `GEMINI_EMBEDDING_RPM_LIMIT` / `_TPM_LIMIT` / `_RPD_LIMIT` | 80 / 24000 / 800 | real limits 100 / 30000 / 1000 |
| `RAG_CONTEXT_TOP_K` / `RAG_CONTEXT_TOP_K_DIAGNOSTIC` | 6 / 8 | chunks passed to the model |

All settings live in `rag/config.py` and can be overridden in `.env`. Changing the embedding
model invalidates the index: `VectorStore.load` refuses a store built with another model.

## PDF ingestion and index creation

```bash
.venv/bin/python ingest.py --dry-run   # what would be embedded, no API call
.venv/bin/python ingest.py             # extract, chunk, embed what is new, build the index
.venv/bin/python ingest.py --rebuild   # rebuild the index from cached embeddings, no API call
```

- **Extraction** (`rag/extract.py`). PyMuPDF reads each page into an ordered stream of headings,
  paragraphs and tables. Tables are detected and kept as row and column grids; the caption stays
  attached; a table continued on the next page is joined. The contents listing, running headers
  and footers are dropped. Channel names that a narrow column wraps mid-word
  (`MAIN_MOTOR_C` / `URRENT`) are healed.
- **Chunking** (`rag/chunk.py`). Chunks never cross a top-level section. Small subsections are
  packed together, a table is never split from its caption, an oversized table is split by rows
  with caption and header row repeated, prose carries a short overlap. Target about 750 tokens,
  maximum about 1000. Result: 261 chunks, median about 490 tokens.
- **Metadata** on every chunk: `machine`, `document`, `document_type`, `doc_no`, `section`,
  `section_numbers`, `page`, `page_end`, `tables`, `sensors`, `components`, `fault_codes`,
  `filename`, `source`, `chunk_id`, `content_hash`. Each chunk is embedded with a one-line header
  naming machine, document and section.
- **Vector store** (`rag/store.py`). FAISS exact inner-product index in `data/vector_store/`, with
  the chunk metadata beside it. Machine filtering happens inside the search (ID selector).
- **Incremental**. Embeddings are cached in `data/embeddings/embedding_cache.sqlite` under a hash
  of model, dimension and chunk text. A second `ingest.py` sends zero requests; a changed or new
  PDF only embeds its changed chunks. The first full ingestion cost 261 embedding inputs.

## Querying

```bash
.venv/bin/python query.py --machine press-stamp-01 \
  "The bearing vibration has exceeded the warning threshold. What could be causing this and what should I inspect?"
.venv/bin/python query.py "What is the alarm limit for axis 4 servo torque on robot-weld-01?"
.venv/bin/python query.py --retrieve-only "..."   # evidence only, no generation request
.venv/bin/python query.py --json "..."            # the dict the agent receives
.venv/bin/python query.py                         # interactive
```

Output: `Answer`, `Evidence` (file, section, page for every cited source), `Machine`, `Confidence`.

### Interface for the diagnostic agent

```python
from rag.api import retrieve_evidence, diagnose

retrieve_evidence("What should I inspect?", machine="press-stamp-01",
                  telemetry={"BEARING_VIBRATION_RMS": "3.0 mm/s", "LUBE_OIL_PRESSURE": "3.4 bar"})
# -> {"query", "machine", "analysis", "evidence": [{"ref", "text", "machine", "document",
#     "document_type", "section", "page", "filename", "source", "chunk_id", "sensors",
#     "components", "fault_codes", "score", "similarity"}, ...]}       no generation request

diagnose(...same arguments...)
# -> the above plus {"answer", "insufficient_information", "confidence", "model", "cached"},
#    and "cited": true/false on each evidence item                    one generation request
```

`rag/api.py` is the whole integration surface. Run it with `RAG/` as the working directory or on
`PYTHONPATH`. It takes readings, never the simulator's active scenario.

### How retrieval works (`rag/retrieve.py`)

1. **Query analysis, local.** Machine (explicit ID, the `--machine` argument, or vocabulary that
   only one machine's documents use), sensors, intents, fault codes, table numbers, readings with
   units, and whether the question is diagnostic.
2. **Machine filter.** When a machine is known, only its chunks are searched. This is a hard
   filter, not a boost.
3. **Dense search** with the cached query embedding, and **BM25** over the same chunks.
4. **Fusion and rerank, local.** Reciprocal rank fusion (lexical weight 0.15), a boost for an exact
   fault code or table number, a penalty for cover pages.
5. **Context selection.** A factual question gets the 6 best chunks. A diagnostic question gets 8,
   and the best chunk of each document type (limits, fault signatures, decision logic, maintenance,
   cases) is taken first, so the model sees evidence for every stage of the chain
   telemetry -> threshold -> fault -> differentiation -> inspection -> action -> verification.

### Generation (`rag/generate.py`)

One request per question. The system prompt requires: answer only from the numbered sources, copy
numbers exactly with units, cite `[S#]` per claim, never use another machine's facts, reply with
the fixed sentence *"The available technical documentation does not provide sufficient information
to determine this."* when the sources do not hold the answer, label any reasoning beyond the
sources as `Engineering inference:`, and use the diagnostic headings (Condition, Threshold
interpretation, Possible faults, Fault differentiation, Recommended inspection, Recommended action,
Verification) for diagnostic questions. `Confidence` is a local heuristic from retrieval
similarity and agreement between dense and keyword search; it is not a calibrated probability.

## Evaluation

```bash
.venv/bin/python evaluate.py validate     # gold labels against the current chunks, no API
.venv/bin/python evaluate.py retrieval    # Recall@k, MRR, isolation, ablations
.venv/bin/python evaluate.py generation   # one cached generation call per question
.venv/bin/python evaluate.py judge        # optional Gemini second opinion, 8 batched calls, cached
.venv/bin/python evaluate.py report       # rebuild the report from saved results, no API
```

Question sets are in `evaluation/questions/`, results and the report in `evaluation/results/`.

- **Retrieval set, 62 queries** (`retrieval.jsonl`): 50 single-topic queries across thresholds,
  operating conditions, fault identification, differentiation, procedures, maintenance,
  troubleshooting, components, telemetry interpretation and cases, plus 12 multi-step diagnostic
  scenarios. Gold is a list of document sections that hold the answer. A hit is a retrieved chunk
  from a gold section of the right machine. `validate` checks that every gold section exists and
  that the stated answer value really is inside a gold chunk. Multi-step queries label gold
  sections per stage, and **stage coverage** measures how many stages have evidence in the context
  actually given to the model.
- **Generation set, 64 questions** (`generation.jsonl`): 17 numeric threshold questions, 16
  multi-step diagnostic scenarios, 15 fault, component, action and inspection questions, 8
  questions whose answer is not in the documents, and 6 cross-machine isolation questions. Each
  has a reference answer written from the PDFs and deterministic checks: values that must appear,
  alternatives of which one must appear, values that must not appear (the other machine's limits).
- **Scoring is deterministic first.** Correctness is the required-value check. Groundedness
  requires every number in the answer to occur in the retrieved evidence or the question, plus a
  citation. The Gemini judge is a second opinion only and is reported separately.
- **No machine argument is passed** unless a question is marked `machine_arg`, so machine
  detection is part of what is measured.

## Quota management and caching

| Mechanism | Where | Effect |
|---|---|---|
| Sliding-window RPM and TPM limiter | `rag/gemini.py` `RateLimiter` | waits before a call, never bursts |
| Daily budget | counted from `logs/api_usage.jsonl`, Pacific quota day | refuses with `QuotaExceeded` before the real limit |
| Backoff | `_call` | 429 and 5xx only: 20 s, 40 s, 80 s, 160 s, or the server's `retryDelay`; sequential; SDK retries off |
| Embedding cache | `data/embeddings/embedding_cache.sqlite` | each chunk and each query text is embedded once, ever |
| Generation cache | `evaluation/cache/generation_cache.sqlite` | keyed on model, prompt version, system prompt and full prompt with context |
| Batching | embeddings, 8 texts per call | fewer round trips; quota is still counted per text |
| Usage log | `logs/api_usage.jsonl` | timestamp, model, operation, tokens, success, HTTP status, retry count |

Re-running ingestion, the retrieval benchmark, the generation benchmark or the report with
unchanged inputs makes no API call. Changing the prompt or the retrieval changes the cache key
for the affected questions only.

## Actual evaluation results

Measured on 2026-10-09 with `gemini-3.5-flash-lite`, `gemini-embedding-2`, prompt version v3.
Full report: `evaluation/results/evaluation_report.txt`. Per-question detail:
`retrieval_hybrid.json`, `generation.json`, `judge.json` in the same folder.

**Corpus:** 10 PDFs (5 per machine), 261 chunks (122 press-stamp-01, 139 robot-weld-01).

| Metric | Target | Result | |
|---|---|---|---|
| Retrieval Recall@1 (62 queries) | | 83.9% | |
| Retrieval Recall@3 | | 96.8% | |
| Retrieval Recall@5 | 90% | **98.4%** | PASS |
| Retrieval Recall@10 | | 100.0% | |
| MRR@10 | | 0.904 | |
| Answer correctness (64 questions) | 90% | **92.2%** | PASS |
| Threshold accuracy (17 numeric questions) | 90% | **100.0%** | PASS |
| Insufficient-information accuracy (10 unanswerable questions) | 90% | **100.0%** | PASS |
| Groundedness | 90% | **98.4%** | PASS |
| Unsupported claims (a number not in the evidence) | | 0.0% | |
| Machine isolation (126 queries) | 95% | **100.0%** | PASS |
| Cross-machine value leaked into an answer | | 0.0% | |
| **Multi-step diagnostic correctness (16 scenarios)** | 90% | **75.0%** | **FAIL** |
| Multi-step retrieval: mean stage coverage in context (12 queries) | | 86.1% | |
| Multi-step retrieval: all stages covered | | 66.7% (8 of 12) | |

**Overall: FAIL.** Six of seven criteria pass. The system does not reach 90% on multi-step
diagnostic questions, which is the use case that matters most, so the overall result is reported
as a fail and no 90% claim is made for diagnosis.

What the numbers say:

- **Retrieval is strong.** One query of 62 misses at k=5 (RR10, gearbox wear versus lubrication
  degradation: the two fault profiles rank above the comparison table, first gold chunk at rank 8).
  Ablation on the same queries: hybrid with rerank R@1 83.9%, dense only 79.0%, BM25 only 59.7%.
- **Single-fact answers are reliable.** Thresholds 17 of 17, unanswerable questions 10 of 10
  declined with no invented value, no answer used the other machine's limits.
- **Multi-step diagnosis is the weak component, and it is the generation step.** 12 of 16
  scenarios pass every required element. The four failures:
  - GD01 (pressure 2.4 bar and vibration 4.8 mm/s): fault and repair correct, but the answer does
    not prescribe the controlled stop that the critical pressure level requires.
  - GD04 (mixed evidence): correct "filter first" decision, but the readings are never classified
    against the limits.
  - GD07 (peak 31 Nm for two cycles): level and response correct, the notified role (maintenance
    supervisor) is missing; the escalation matrix that names it was not in the context.
  - GD10 (lubrication loss turning into wear): diagnosis and action correct, the 0.4 Nm ripple
    criterion from the reference is not quoted. This check is stricter than the question strictly
    requires; it was left as written.
  The fifth failed question, GP10, answers "never reaches the alarm" correctly and omits the
  3.2 mm/s peak the reference expects.
- **Three prompt versions were run** against the same 64 questions, changing the system, not the
  checks: v1 92.2% overall and 75.0% diagnostic, v2 90.6% and 68.8%, v3 92.2% and 75.0%. Prompt
  wording moves which scenarios fail, not how many. The earlier runs are kept in
  `generation_prompt_v1.json` and `generation_prompt_v2.json`.
- **The Gemini judge rated all 64 answers correct with no unsupported claim.** That is more
  lenient than the deterministic checks (it accepted the four diagnostic answers above), so it is
  reported as a second opinion only and none of the pass or fail decisions use it.

API use for the whole build and evaluation, from `logs/api_usage.jsonl`: 392 embedding inputs
(261 chunks once, the rest queries) and 238 generation requests across three benchmark runs,
the judge and manual tests, 0 HTTP 429 responses, and about 35 HTTP 503 (model overloaded) responses, each retried sequentially with backoff.

## Known limitations

- **Multi-step diagnosis is at 75%, below the 90% target.** For the agent integration the safer
  path is `retrieve_evidence()` (98.4% Recall@5, 100% isolation) with the agent's own reasoning
  model doing the diagnosis, or a stronger generation model set in `GEMINI_GENERATION_MODEL`.
  Neither was evaluated here.
- **Small benchmark, no held-out split.** 62 retrieval and 64 generation questions, written by the
  same author who built the system, from the same PDFs. The fusion weight, the removal of the
  intent prior and the three prompt versions were chosen while looking at these questions, so the
  reported numbers are optimistic for unseen questions. With n=16 one diagnostic scenario is
  6 points.
- **Retrieval gold is section-level.** A hit means a chunk from a section known to hold the answer,
  which is looser than exact-passage relevance. Because the documents repeat key values in several
  sections, some correct retrievals outside the labelled sections count as misses.
- **Stage coverage is 86%.** In 4 of 12 multi-step queries one stage (most often the maintenance
  action or the escalation matrix) has no labelled evidence in the 8-chunk context.
- **Deterministic correctness is a required-value check**, not a full semantic judgment. It can
  pass an answer that contains the right values around a wrong sentence, and it fails a correct
  answer that omits an expected value. Groundedness checks numbers and citations, not prose claims.
- **Extraction artefacts.** A few words that the PDF wraps mid-word inside narrow table cells stay
  split ("classif ication", "Irregula r"). Channel names and units are healed; other words are not.
  Figures and images are not read.
- **Machine detection is vocabulary based.** A question that names no machine and uses only shared
  words ("bearing", "lubrication", "warning threshold") is searched across both machines; pass
  `machine=` from the agent, which always knows it.
- **Confidence is a heuristic** from retrieval similarity, not a calibrated probability.
- **The corpus is a prototype knowledge base.** The PDFs state that the telemetry is simulated and
  the limits are illustrative, not OEM values. The system reproduces them as written.
- **Quota day.** The daily budget is counted from this module's own log, so requests made with the
  same key elsewhere are not seen. The default budget (350 of 500) leaves room for that.

## Layout

```
RAG/
├── PRESS_STAMP/, ROBOT_WELD/      source PDFs (read only)
├── rag/
│   ├── config.py                  paths, models, quota ceilings
│   ├── extract.py                 PDF -> headings, paragraphs, tables
│   ├── chunk.py                   structure-aware chunks with metadata
│   ├── gemini.py                  limiter, backoff, usage log, both caches
│   ├── store.py                   FAISS store with metadata filter
│   ├── retrieve.py                query analysis, hybrid search, rerank, context selection
│   ├── generate.py                grounded prompt and answer
│   ├── api.py                     retrieve_evidence() and diagnose() for the agent
│   └── evaluation.py              benchmarks and scoring
├── ingest.py  query.py  evaluate.py
├── data/chunks, data/embeddings, data/vector_store
├── evaluation/questions, evaluation/cache, evaluation/results
├── logs/api_usage.jsonl
├── requirements.txt  .env.example
```
