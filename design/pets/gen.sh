#!/usr/bin/env bash
# 夥伴的 AI 圖：產生腳本（開發用，不會被部署——design/ 不在 public/ 底下）
#
# 金鑰：不寫在這裡。雲端工作環境的 Network secrets 已經存了 api.openai.com 的 key，
# 代理會自動把 Authorization 換成真的，所以這裡送 "Bearer dummy" 就好。
# 在自己的電腦上跑的話：export OPENAI_API_KEY=... 然後把 dummy 換成 $OPENAI_API_KEY。
#
# 用法：
#   bash design/pets/gen.sh adult  <輸出.png> "<這一隻的長相描述>"
#   bash design/pets/gen.sh edit   <參考.png> <輸出.png> "<這一張要什麼姿勢／年紀／表情>"
#
# 為什麼是 gpt-image-1.5：它支援 background=transparent。gpt-image-2 回
# "Transparent background is not supported for this model"，透明背景是放進卡片的前提。
# 為什麼先畫成年、再用 edits 往回畫：用同一張參考圖，條紋、腮紅、眼睛才會一致，
# 看得出是「同一隻」。各自從頭生的話每一張都是不同的貓。
set -euo pipefail
KEY="${OPENAI_API_KEY:-dummy}"
MODEL=gpt-image-1.5

STYLE="Needle-felted wool figurine, soft fuzzy wool fibers clearly visible, gentle rounded shapes, warm natural coloring only (no green accents), cozy healing Japanese zakka style, single character centered and filling most of the frame, full body, facing the viewer, cute, no text, no props, no background, soft even studio lighting."
KEEP="This must be the SAME character as the reference image: identical needle-felted wool material and fiber texture, identical fur colors and markings, same face (eyes, nose, cheeks), same art style and soft lighting. Only the age, pose or expression changes. Single character centered, full body, no text, no props, no background, transparent background."

case "$1" in
  adult)
    out="$2"; desc="$3"
    curl -s https://api.openai.com/v1/images/generations \
      -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
      -d "$(jq -n --arg m "$MODEL" --arg p "$desc $STYLE" \
            '{model:$m,prompt:$p,size:"1024x1024",quality:"high",background:"transparent",output_format:"png"}')" \
      | tee /tmp/gen.json | jq -r '.data[0].b64_json' | base64 -d > "$out"
    ;;
  edit)
    ref="$2"; out="$3"; desc="$4"
    curl -s https://api.openai.com/v1/images/edits -H "Authorization: Bearer $KEY" \
      -F model=$MODEL -F image=@"$ref" -F background=transparent -F output_format=png \
      -F size=1024x1024 -F quality=high --form-string "prompt=$desc $KEEP" \
      | tee /tmp/gen.json | jq -r '.data[0].b64_json' | base64 -d > "$out"
    ;;
  *) echo "用法見檔案開頭" >&2; exit 1 ;;
esac
jq -r '.error.message // empty' /tmp/gen.json >&2
ls -la "$out"
