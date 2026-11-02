#!/bin/bash
# Offline gold eval (no gateway). Usage: run_eval.sh <judge: jev|llm> <retrieval: judge|bm25> <run-name>
# Keys come from ENV_FILE (default ~/.openclaw-memtest/.env): DEEPSEEK_API_KEY, JEV_API_KEY.
set -e
set -a; . "${ENV_FILE:-$HOME/.openclaw-memtest/.env}"; set +a
cd "$(dirname "$0")/../.."
mkdir -p runs
node scripts/eval_gold.ts --data data/goldset_v2.json --judge "$1" --retrieval "$2" --concurrency 4 --out "runs/$3" > "runs/$3.log" 2>&1
