#!/bin/zsh
# core.mjs(ESM)를 확장에서 쓰는 일반 스크립트(core.js)로 변환한다.
# 계산 로직의 원본은 core.mjs 하나만 유지한다.
set -e
DIR="${0:A:h}"
{
  echo "// 자동 생성 파일 — 수정은 core.mjs 에서 하고 ./build.sh 를 실행할 것"
  sed 's/^export //' "$DIR/core.mjs"
} > "$DIR/extension/core.js"
echo "extension/core.js 생성 완료"
